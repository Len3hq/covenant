//! Bitcoin adapter: P2WPKH vault inputs, SIGHASH_ALL, allow-listed outputs, change to the vault.
//! See docs/SPEC.md, "Bitcoin adapter spec", and corrections C1 and C2 in docs/BUILD_PLAN.md.

use covenant_policy::{
    AssetId, ChainKind, CovenantError, ParsedTx, Payment, Policy, SignPayload, TxMeta,
};
use near_sdk::env;
use near_sdk::json_types::U128;

const MAX_OUTPUTS: u64 = 8;
const MIN_OUTPUT_SATS: u64 = 330;
const OP_RETURN: u8 = 0x6a;
const SIGHASH_ALL: u32 = 1;
const OUTPOINT_LEN: usize = 36;

/// The vault's own Bitcoin key, used to recognise its inputs and change.
pub struct BitcoinVault<'a> {
    pub pubkey: &'a [u8; 33],
}

/// Reads Bitcoin's wire format. Every malformed read is `MalformedTx`.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], CovenantError> {
        if count > self.bytes.len() {
            return Err(CovenantError::MalformedTx);
        }
        let (taken, rest) = self.bytes.split_at(count);
        self.bytes = rest;
        Ok(taken)
    }

    fn u32_le(&mut self) -> Result<u32, CovenantError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64_le(&mut self) -> Result<u64, CovenantError> {
        let low = self.u32_le()? as u64;
        let high = self.u32_le()? as u64;
        Ok(high << 32 | low)
    }

    /// Refuses a longer encoding than the value needs, as Bitcoin nodes do.
    fn varint(&mut self) -> Result<u64, CovenantError> {
        let first = self.take(1)?[0];
        let (value, minimum) = match first {
            0xfd => {
                let bytes = self.take(2)?;
                (u16::from_le_bytes([bytes[0], bytes[1]]) as u64, 0xfd)
            }
            0xfe => (self.u32_le()? as u64, 0x1_0000),
            0xff => (self.u64_le()?, 0x1_0000_0000),
            small => return Ok(small as u64),
        };
        if value < minimum {
            return Err(CovenantError::MalformedTx);
        }
        Ok(value)
    }

    fn script(&mut self) -> Result<&'a [u8], CovenantError> {
        let length = self.varint()?;
        self.take(usize::try_from(length).map_err(|_| CovenantError::MalformedTx)?)
    }

    fn output(&mut self) -> Result<Output<'a>, CovenantError> {
        Ok(Output {
            amount: self.u64_le()?,
            script: self.script()?,
        })
    }

    fn finish(&self) -> Result<(), CovenantError> {
        if self.bytes.is_empty() {
            Ok(())
        } else {
            Err(CovenantError::MalformedTx)
        }
    }
}

struct Output<'a> {
    amount: u64,
    script: &'a [u8],
}

struct Input<'a> {
    outpoint: &'a [u8],
    sequence: &'a [u8],
}

/// An unsigned transaction with rule 1's structure checked. Locktime is left to `parse`, so the
/// sighash can be tested against BIP143's own example, which sets one.
struct Unsigned<'a> {
    version: u32,
    inputs: Vec<Input<'a>>,
    outputs: Vec<Output<'a>>,
    raw_outputs: &'a [u8],
    locktime: u32,
}

pub fn double_sha256(bytes: &[u8]) -> [u8; 32] {
    env::sha256_array(env::sha256_array(bytes))
}

pub fn hash160(pubkey: &[u8; 33]) -> [u8; 20] {
    env::ripemd160_array(env::sha256_array(pubkey))
}

pub fn p2wpkh_script(pubkey_hash: &[u8; 20]) -> Vec<u8> {
    let mut script = vec![0x00, 0x14];
    script.extend(pubkey_hash);
    script
}

fn read_unsigned(tx: &[u8], max_inputs: u64) -> Result<Unsigned<'_>, CovenantError> {
    // A zero input count is also how a witness marker reads, so both land here.
    let mut reader = Reader { bytes: tx };
    let version = reader.u32_le()?;
    if !matches!(version, 1 | 2) {
        return Err(CovenantError::MalformedTx);
    }
    let input_count = reader.varint()?;
    if input_count == 0 {
        return Err(CovenantError::MalformedTx);
    }
    if input_count > max_inputs {
        return Err(CovenantError::TooManyInputs);
    }
    let mut inputs: Vec<Input> = Vec::new();
    for _ in 0..input_count {
        let outpoint = reader.take(OUTPOINT_LEN)?;
        if !reader.script()?.is_empty() {
            return Err(CovenantError::MalformedTx);
        }
        let sequence = reader.take(4)?;
        if inputs.iter().any(|input| input.outpoint == outpoint) {
            return Err(CovenantError::MalformedTx);
        }
        inputs.push(Input { outpoint, sequence });
    }
    let output_count = reader.varint()?;
    if output_count == 0 || output_count > MAX_OUTPUTS {
        return Err(CovenantError::MalformedTx);
    }
    let outputs_start = reader.bytes;
    let mut outputs = Vec::new();
    for _ in 0..output_count {
        outputs.push(reader.output()?);
    }
    let raw_outputs = &outputs_start[..outputs_start.len() - reader.bytes.len()];
    let locktime = reader.u32_le()?;
    reader.finish()?;
    Ok(Unsigned {
        version,
        inputs,
        outputs,
        raw_outputs,
        locktime,
    })
}

/// The BIP143 SIGHASH_ALL hash for each input, spending `amounts` from one P2WPKH key.
fn sighashes(tx: &Unsigned, amounts: &[u64], pubkey_hash: &[u8; 20]) -> Vec<[u8; 32]> {
    let mut outpoints = Vec::with_capacity(tx.inputs.len() * OUTPOINT_LEN);
    let mut sequences = Vec::with_capacity(tx.inputs.len() * 4);
    for input in &tx.inputs {
        outpoints.extend(input.outpoint);
        sequences.extend(input.sequence);
    }
    let hash_prevouts = double_sha256(&outpoints);
    let hash_sequence = double_sha256(&sequences);
    let hash_outputs = double_sha256(tx.raw_outputs);

    tx.inputs
        .iter()
        .zip(amounts)
        .map(|(input, amount)| {
            let mut preimage = Vec::with_capacity(182);
            preimage.extend(tx.version.to_le_bytes());
            preimage.extend(hash_prevouts);
            preimage.extend(hash_sequence);
            preimage.extend(input.outpoint);
            preimage.extend([0x19, 0x76, 0xa9, 0x14]);
            preimage.extend(pubkey_hash);
            preimage.extend([0x88, 0xac]);
            preimage.extend(amount.to_le_bytes());
            preimage.extend(input.sequence);
            preimage.extend(hash_outputs);
            preimage.extend(tx.locktime.to_le_bytes());
            preimage.extend(SIGHASH_ALL.to_le_bytes());
            double_sha256(&preimage)
        })
        .collect()
}

/// Finds the output an input spends, after proving `prev_tx` is the transaction it names.
///
/// A serialized outpoint holds the txid in the same byte order the hash produces, so the two
/// compare directly (C1). A witness-serialized prev tx is refused because it can't hash to its
/// txid (C2); the agent strips witness data first.
fn spent_output<'a>(prev_tx: &'a [u8], outpoint: &[u8]) -> Result<Output<'a>, CovenantError> {
    if prev_tx.get(4) == Some(&0) {
        return Err(CovenantError::MalformedTx);
    }
    let (txid, vout) = outpoint.split_at(32);
    if double_sha256(prev_tx) != txid {
        return Err(CovenantError::PrevTxMismatch);
    }
    let vout = u32::from_le_bytes([vout[0], vout[1], vout[2], vout[3]]) as u64;

    let mut reader = Reader { bytes: prev_tx };
    reader.take(4)?;
    for _ in 0..reader.varint()? {
        reader.take(36)?;
        reader.script()?;
        reader.take(4)?;
    }
    let mut spent = None;
    for index in 0..reader.varint()? {
        let output = reader.output()?;
        if index == vout {
            spent = Some(output);
        }
    }
    reader.take(4)?;
    reader.finish()?;
    spent.ok_or(CovenantError::InputNotOwned)
}

/// Parses an unsigned transaction into its payments, fee and one BIP143 sighash per input,
/// enforcing spec rules 1 to 5.
pub fn parse(
    tx: &[u8],
    meta: &TxMeta,
    policy: &Policy,
    vault: &BitcoinVault<'_>,
) -> Result<ParsedTx, CovenantError> {
    let TxMeta::Bitcoin { prev_txs } = meta else {
        return Err(CovenantError::MalformedTx);
    };

    // Rule 1.
    let unsigned = read_unsigned(tx, policy.btc_max_inputs as u64)?;
    if unsigned.locktime != 0 {
        return Err(CovenantError::MalformedTx);
    }

    // Rule 2. `prev_txs` lines up with the inputs, one for each.
    if prev_txs.len() != unsigned.inputs.len() {
        return Err(CovenantError::PrevTxMismatch);
    }
    let pubkey_hash = hash160(vault.pubkey);
    let own_script = p2wpkh_script(&pubkey_hash);
    let mut amounts = Vec::with_capacity(unsigned.inputs.len());
    let mut total_in: u64 = 0;
    for (input, prev_tx) in unsigned.inputs.iter().zip(prev_txs) {
        let spent = spent_output(&prev_tx.0, input.outpoint)?;
        if spent.script != own_script.as_slice() {
            return Err(CovenantError::InputNotOwned);
        }
        total_in = total_in
            .checked_add(spent.amount)
            .ok_or(CovenantError::MalformedTx)?;
        amounts.push(spent.amount);
    }

    // Rule 3.
    let mut payments = Vec::new();
    let mut total_out: u64 = 0;
    for output in &unsigned.outputs {
        if output.script.first() == Some(&OP_RETURN) || output.amount < MIN_OUTPUT_SATS {
            return Err(CovenantError::UnsupportedScript);
        }
        total_out = total_out
            .checked_add(output.amount)
            .ok_or(CovenantError::MalformedTx)?;
        if output.script == own_script.as_slice() {
            continue;
        }
        let listed = policy
            .payees
            .iter()
            .any(|p| p.chain == ChainKind::Bitcoin && p.to == output.script);
        if !listed {
            return Err(CovenantError::OutputNotWhitelisted);
        }
        payments.push(Payment {
            asset: AssetId::Btc,
            to: output.script.to_vec(),
            amount: U128(output.amount as u128),
        });
    }

    // Rule 4.
    let fee = total_in
        .checked_sub(total_out)
        .filter(|fee| *fee > 0)
        .ok_or(CovenantError::MalformedTx)?;

    // Rule 5. Cross-multiplied, because dividing would round a rate just over the cap down to it.
    let weight = 4 * tx.len() as u128 + 2 + 108 * unsigned.inputs.len() as u128;
    let vsize = weight.div_ceil(4);
    if fee as u128 > policy.btc_max_fee_rate as u128 * vsize {
        return Err(CovenantError::FeeTooHigh);
    }

    Ok(ParsedTx {
        payments,
        fee: fee as u128,
        fee_asset: AssetId::Btc,
        signing_payloads: sighashes(&unsigned, &amounts, &pubkey_hash)
            .into_iter()
            .map(SignPayload::Ecdsa)
            .collect(),
        vsize: vsize as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hashes(parsed: &ParsedTx) -> Vec<[u8; 32]> {
        parsed
            .signing_payloads
            .iter()
            .map(|payload| match payload {
                SignPayload::Ecdsa(hash) => *hash,
                SignPayload::Eddsa(_) => panic!("bitcoin signs hashes"),
            })
            .collect()
    }
    use covenant_policy::Payee;
    use near_sdk::serde_json::{self, Value};

    const PUBKEY: [u8; 33] = [0x02; 33];
    const FUNDING: &str = include_str!("../../../../tests/vectors/btc_testnet4_funding.json");
    const BIP143: &str = include_str!("../../../../tests/vectors/btc_sighash_bip143.json");
    const SIGHASHES: &str = include_str!("../../../../tests/vectors/btc_sighash.json");

    fn payee_script() -> Vec<u8> {
        let mut script = vec![0x00, 0x14];
        script.extend([0xaa; 20]);
        script
    }

    fn foreign_script() -> Vec<u8> {
        let mut script = vec![0x00, 0x14];
        script.extend([0xbb; 20]);
        script
    }

    fn own_script() -> Vec<u8> {
        p2wpkh_script(&hash160(&PUBKEY))
    }

    fn policy() -> Policy {
        Policy {
            caps: vec![],
            payees: vec![Payee {
                chain: ChainKind::Bitcoin,
                to: payee_script(),
                label: "supplier".into(),
            }],
            btc_max_fee_rate: 50,
            btc_max_inputs: 3,
            evm_chain_ids: vec![84532],
            evm_max_gas_cost: U128(1),
            veto_delay_ns: 1,
            sol_max_fee: U128(0),
        }
    }

    fn varint(value: usize) -> Vec<u8> {
        assert!(value < 0xfd);
        vec![value as u8]
    }

    fn output(amount: u64, script: &[u8]) -> Vec<u8> {
        let mut bytes = amount.to_le_bytes().to_vec();
        bytes.extend(varint(script.len()));
        bytes.extend(script);
        bytes
    }

    /// A previous transaction with the given outputs. `salt` gives each one its own txid.
    fn prev_tx(outputs: &[(u64, Vec<u8>)], salt: u8) -> Vec<u8> {
        let mut bytes = vec![2, 0, 0, 0, 1];
        bytes.extend([salt; 32]);
        bytes.extend([0; 4]);
        bytes.push(0);
        bytes.extend([0xff; 4]);
        bytes.extend(varint(outputs.len()));
        for (amount, script) in outputs {
            bytes.extend(output(*amount, script));
        }
        bytes.extend([0; 4]);
        bytes
    }

    fn unsigned(inputs: &[([u8; 32], u32)], outputs: &[(u64, Vec<u8>)]) -> Vec<u8> {
        let mut bytes = vec![2, 0, 0, 0];
        bytes.extend(varint(inputs.len()));
        for (txid, vout) in inputs {
            bytes.extend(txid);
            bytes.extend(vout.to_le_bytes());
            bytes.push(0);
            bytes.extend([0xfd, 0xff, 0xff, 0xff]);
        }
        bytes.extend(varint(outputs.len()));
        for (amount, script) in outputs {
            bytes.extend(output(*amount, script));
        }
        bytes.extend([0; 4]);
        bytes
    }

    fn meta(prev_txs: &[&[u8]]) -> TxMeta {
        TxMeta::Bitcoin {
            prev_txs: prev_txs.iter().map(|p| p.to_vec().into()).collect(),
        }
    }

    fn run(tx: &[u8], prev_txs: &[&[u8]]) -> Result<ParsedTx, CovenantError> {
        parse(
            tx,
            &meta(prev_txs),
            &policy(),
            &BitcoinVault { pubkey: &PUBKEY },
        )
    }

    /// One funded vault coin of 100,000 sats and its outpoint.
    fn coin() -> (Vec<u8>, [u8; 32]) {
        let prev = prev_tx(&[(100_000, own_script())], 1);
        let txid = double_sha256(&prev);
        (prev, txid)
    }

    #[test]
    fn btc_accepts_whitelisted_payment_with_change() {
        let (prev, txid) = coin();
        let tx = unsigned(
            &[(txid, 0)],
            &[(60_000, payee_script()), (39_000, own_script())],
        );
        let parsed = run(&tx, &[&prev]).unwrap();
        assert_eq!(
            parsed.payments,
            vec![Payment {
                asset: AssetId::Btc,
                to: payee_script(),
                amount: U128(60_000),
            }]
        );
        assert_eq!(parsed.fee, 1_000);
    }

    #[test]
    fn btc_rejects_unlisted_output() {
        let (prev, txid) = coin();
        let tx = unsigned(&[(txid, 0)], &[(60_000, foreign_script())]);
        assert_eq!(run(&tx, &[&prev]), Err(CovenantError::OutputNotWhitelisted));
    }

    #[test]
    fn btc_rejects_change_to_foreign_script() {
        let (prev, txid) = coin();
        let tx = unsigned(
            &[(txid, 0)],
            &[(60_000, payee_script()), (39_000, foreign_script())],
        );
        assert_eq!(run(&tx, &[&prev]), Err(CovenantError::OutputNotWhitelisted));
    }

    #[test]
    fn btc_rejects_fee_rate_above_cap() {
        let (prev, txid) = coin();
        let tx = unsigned(&[(txid, 0)], &[(1_000, payee_script())]);
        assert_eq!(run(&tx, &[&prev]), Err(CovenantError::FeeTooHigh));
    }

    #[test]
    fn btc_fee_rate_cap_is_exact() {
        let (prev, txid) = coin();
        let shape = unsigned(&[(txid, 0)], &[(1_000, payee_script())]);
        let weight = 4 * shape.len() as u64 + 2 + 108;
        let cap_fee = weight.div_ceil(4) * policy().btc_max_fee_rate;

        let at_cap = unsigned(&[(txid, 0)], &[(100_000 - cap_fee, payee_script())]);
        assert_eq!(run(&at_cap, &[&prev]).unwrap().fee, cap_fee as u128);

        let one_over = unsigned(&[(txid, 0)], &[(100_000 - cap_fee - 1, payee_script())]);
        assert_eq!(run(&one_over, &[&prev]), Err(CovenantError::FeeTooHigh));
    }

    #[test]
    fn btc_rejects_prev_tx_mismatch() {
        let (prev, txid) = coin();
        let tx = unsigned(&[(txid, 0)], &[(60_000, payee_script())]);

        // The attack the check exists for: the same prev tx with a larger amount claimed.
        let lying = prev_tx(&[(100_000_000, own_script())], 1);
        assert_eq!(run(&tx, &[&lying]), Err(CovenantError::PrevTxMismatch));

        assert_eq!(run(&tx, &[]), Err(CovenantError::PrevTxMismatch));
        assert_eq!(
            run(&tx, &[&prev, &prev]),
            Err(CovenantError::PrevTxMismatch)
        );
    }

    #[test]
    fn btc_compares_the_raw_hash_with_the_outpoint() {
        let (prev, mut txid) = coin();
        txid.reverse();
        let tx = unsigned(&[(txid, 0)], &[(60_000, payee_script())]);
        assert_eq!(run(&tx, &[&prev]), Err(CovenantError::PrevTxMismatch));
    }

    #[test]
    fn btc_rejects_input_not_owned() {
        let prev = prev_tx(&[(100_000, foreign_script())], 1);
        let tx = unsigned(&[(double_sha256(&prev), 0)], &[(60_000, payee_script())]);
        assert_eq!(run(&tx, &[&prev]), Err(CovenantError::InputNotOwned));

        let (prev, txid) = coin();
        let missing_output = unsigned(&[(txid, 1)], &[(60_000, payee_script())]);
        assert_eq!(
            run(&missing_output, &[&prev]),
            Err(CovenantError::InputNotOwned)
        );
    }

    #[test]
    fn btc_rejects_witness_serialization() {
        let (prev, txid) = coin();
        let tx = unsigned(&[(txid, 0)], &[(60_000, payee_script())]);
        let mut witness = tx[..4].to_vec();
        witness.extend([0x00, 0x01]);
        witness.extend(&tx[4..]);
        assert_eq!(run(&witness, &[&prev]), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn btc_rejects_witness_prev_tx() {
        let (prev, _) = coin();
        let mut witness = prev[..4].to_vec();
        witness.extend([0x00, 0x01]);
        witness.extend(&prev[4..]);
        // Even an outpoint naming the witness bytes' own hash is refused.
        let tx = unsigned(&[(double_sha256(&witness), 0)], &[(60_000, payee_script())]);
        assert_eq!(run(&tx, &[&witness]), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn btc_rejects_too_many_inputs() {
        let txs: Vec<Vec<u8>> = (1..=4)
            .map(|salt| prev_tx(&[(100_000, own_script())], salt))
            .collect();
        let inputs: Vec<([u8; 32], u32)> = txs.iter().map(|t| (double_sha256(t), 0)).collect();
        let tx = unsigned(&inputs, &[(399_000, payee_script())]);
        let prevs: Vec<&[u8]> = txs.iter().map(Vec::as_slice).collect();
        assert_eq!(run(&tx, &prevs), Err(CovenantError::TooManyInputs));

        let within_limit = unsigned(&inputs[..3], &[(299_000, payee_script())]);
        assert_eq!(run(&within_limit, &prevs[..3]).unwrap().fee, 1_000);
    }

    #[test]
    fn btc_rejects_op_return() {
        let (prev, txid) = coin();
        let data = vec![OP_RETURN, 0x01, 0x42];
        let tx = unsigned(&[(txid, 0)], &[(60_000, data.clone())]);
        assert_eq!(run(&tx, &[&prev]), Err(CovenantError::UnsupportedScript));

        // Refused even when someone allow-lists it.
        let mut listed = policy();
        listed.payees.push(Payee {
            chain: ChainKind::Bitcoin,
            to: data,
            label: "data".into(),
        });
        let result = parse(
            &tx,
            &meta(&[&prev]),
            &listed,
            &BitcoinVault { pubkey: &PUBKEY },
        );
        assert_eq!(result, Err(CovenantError::UnsupportedScript));
    }

    #[test]
    fn btc_rejects_dust_outputs() {
        let (prev, txid) = coin();
        let tx = unsigned(
            &[(txid, 0)],
            &[(329, payee_script()), (99_000, own_script())],
        );
        assert_eq!(run(&tx, &[&prev]), Err(CovenantError::UnsupportedScript));
    }

    #[test]
    fn btc_ignores_a_payee_listed_for_another_chain() {
        let (prev, txid) = coin();
        let tx = unsigned(&[(txid, 0)], &[(60_000, payee_script())]);
        let mut other_chain = policy();
        other_chain.payees[0].chain = ChainKind::Evm;
        let result = parse(
            &tx,
            &meta(&[&prev]),
            &other_chain,
            &BitcoinVault { pubkey: &PUBKEY },
        );
        assert_eq!(result, Err(CovenantError::OutputNotWhitelisted));
    }

    #[test]
    fn btc_consolidation_pays_no_one() {
        let (prev, txid) = coin();
        let tx = unsigned(&[(txid, 0)], &[(99_000, own_script())]);
        let parsed = run(&tx, &[&prev]).unwrap();
        assert!(parsed.payments.is_empty());
        assert_eq!(parsed.fee, 1_000);
    }

    #[test]
    fn btc_rejects_malformed_shapes() {
        let (prev, txid) = coin();
        let good = unsigned(&[(txid, 0)], &[(60_000, payee_script())]);
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("empty", vec![]),
            ("truncated", good[..good.len() - 1].to_vec()),
            ("trailing byte", [good.clone(), vec![0]].concat()),
            ("version 3", [vec![3, 0, 0, 0], good[4..].to_vec()].concat()),
            ("non-zero locktime", {
                let mut tx = good.clone();
                let end = tx.len();
                tx[end - 4] = 1;
                tx
            }),
            ("non-empty scriptSig", {
                let mut tx = good[..41].to_vec();
                tx.extend([1, 0x51]);
                tx.extend(&good[42..]);
                tx
            }),
            ("non-minimal input count", {
                let mut tx = good[..4].to_vec();
                tx.extend([0xfd, 1, 0]);
                tx.extend(&good[5..]);
                tx
            }),
            (
                "duplicate outpoint",
                unsigned(&[(txid, 0), (txid, 0)], &[(60_000, payee_script())]),
            ),
            (
                "nine outputs",
                unsigned(&[(txid, 0)], &vec![(1_000, payee_script()); 9]),
            ),
            ("no outputs", unsigned(&[(txid, 0)], &[])),
            (
                "zero fee",
                unsigned(&[(txid, 0)], &[(100_000, payee_script())]),
            ),
            (
                "negative fee",
                unsigned(&[(txid, 0)], &[(100_001, payee_script())]),
            ),
            (
                "outputs overflow",
                unsigned(
                    &[(txid, 0)],
                    &[(u64::MAX, own_script()), (1_000, own_script())],
                ),
            ),
        ];
        for (name, tx) in cases {
            let prevs: &[&[u8]] = if name == "duplicate outpoint" {
                &[&prev, &prev]
            } else {
                &[&prev]
            };
            assert_eq!(run(&tx, prevs), Err(CovenantError::MalformedTx), "{name}");
        }
    }

    #[test]
    fn btc_rejects_evm_meta() {
        let (_, txid) = coin();
        let tx = unsigned(&[(txid, 0)], &[(60_000, payee_script())]);
        let result = parse(
            &tx,
            &TxMeta::Evm,
            &policy(),
            &BitcoinVault { pubkey: &PUBKEY },
        );
        assert_eq!(result, Err(CovenantError::MalformedTx));
    }

    /// Real chain data: the testnet4 transaction that first funded the deployed vault.
    #[test]
    fn btc_accepts_a_real_testnet4_funding_tx() {
        let vector: Value = serde_json::from_str(FUNDING).unwrap();
        let text = |key: &str| vector[key].as_str().unwrap().to_string();
        let pubkey: [u8; 33] = hex::decode(text("vault_pubkey"))
            .unwrap()
            .try_into()
            .unwrap();
        let prev = hex::decode(text("non_witness_hex")).unwrap();

        // A txid displays reversed, and the outpoint holds the raw hash (C1).
        let mut txid: [u8; 32] = hex::decode(text("txid")).unwrap().try_into().unwrap();
        txid.reverse();
        assert_eq!(double_sha256(&prev), txid);

        let vout = vector["vault_vout"].as_u64().unwrap() as u32;
        let amount = vector["vault_amount"].as_u64().unwrap();
        let tx = unsigned(&[(txid, vout)], &[(amount - 1_000, payee_script())]);
        let vault = BitcoinVault { pubkey: &pubkey };
        let parsed = parse(&tx, &meta(&[&prev]), &policy(), &vault).unwrap();
        assert_eq!(parsed.fee, 1_000);

        // What the explorer API returns unmodified is refused (C2).
        let witness = hex::decode(text("witness_hex")).unwrap();
        assert_eq!(
            parse(&tx, &meta(&[&witness]), &policy(), &vault),
            Err(CovenantError::MalformedTx)
        );
    }

    fn hex_field(value: &Value) -> Vec<u8> {
        hex::decode(value.as_str().unwrap()).unwrap()
    }

    /// BIP143's own example, then bitcoinjs-lib's vectors through the whole of `parse`, so the
    /// amounts come from the prev txs just as they will in production.
    #[test]
    fn btc_sighash_matches_bip143_vectors() {
        let official: Value = serde_json::from_str(BIP143).unwrap();
        let tx_bytes = hex_field(&official["unsigned_tx"]);
        let tx = read_unsigned(&tx_bytes, u64::MAX).unwrap();
        let pubkey: [u8; 33] = hex_field(&official["pubkey"]).try_into().unwrap();
        let amounts: Vec<u64> = official["amounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|amount| amount.as_u64().unwrap())
            .collect();
        let computed = sighashes(&tx, &amounts, &hash160(&pubkey));
        assert_eq!(
            computed[official["input"].as_u64().unwrap() as usize].to_vec(),
            hex_field(&official["sighash"])
        );

        let generated: Value = serde_json::from_str(SIGHASHES).unwrap();
        let vectors = generated["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 4);
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let pubkey: [u8; 33] = hex_field(&vector["pubkey"]).try_into().unwrap();
            let prev_txs: Vec<_> = vector["prev_txs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|prev| hex_field(prev).into())
                .collect();
            let mut policy = policy();
            policy.btc_max_fee_rate = u64::MAX / 1_000_000;
            policy.payees = vector["payees"]
                .as_array()
                .unwrap()
                .iter()
                .map(|script| Payee {
                    chain: ChainKind::Bitcoin,
                    to: hex_field(script),
                    label: "vector".into(),
                })
                .collect();
            let parsed = parse(
                &hex_field(&vector["unsigned_tx"]),
                &TxMeta::Bitcoin { prev_txs },
                &policy,
                &BitcoinVault { pubkey: &pubkey },
            )
            .unwrap();
            let expected: Vec<[u8; 32]> = vector["sighashes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|hash| hex_field(hash).try_into().unwrap())
                .collect();
            assert_eq!(hashes(&parsed), expected, "{name}");
        }
    }

    /// The 2020 SegWit fee attack. Two proposals spend the same two coins, and each understates the
    /// coin it isn't signing so the fee looks small. Together their signatures would complete a
    /// transaction that burns a huge fee. Lying means altering a previous transaction, which changes
    /// its hash, so neither proposal gets a signature.
    #[test]
    fn btc_blocks_split_fee_attack() {
        const REAL: u64 = 1_000_000;
        const CLAIMED: u64 = 40_000;
        let first = prev_tx(&[(REAL, own_script())], 1);
        let second = prev_tx(&[(REAL, own_script())], 2);
        let tx = unsigned(
            &[(double_sha256(&first), 0), (double_sha256(&second), 0)],
            &[(1_039_000, payee_script())],
        );

        // Honest amounts expose the real fee of 961,000 sats.
        assert_eq!(run(&tx, &[&first, &second]), Err(CovenantError::FeeTooHigh));

        // Each lie would make the fee look like 1,000 sats.
        let first_lie = prev_tx(&[(CLAIMED, own_script())], 1);
        let second_lie = prev_tx(&[(CLAIMED, own_script())], 2);
        assert_eq!(
            run(&tx, &[&first, &second_lie]),
            Err(CovenantError::PrevTxMismatch)
        );
        assert_eq!(
            run(&tx, &[&first_lie, &second]),
            Err(CovenantError::PrevTxMismatch)
        );
    }

    #[test]
    fn btc_sighash_commits_to_each_input_amount() {
        let (prev, txid) = coin();
        let tx = unsigned(&[(txid, 0)], &[(99_000, payee_script())]);
        let parsed = run(&tx, &[&prev]).unwrap();
        let read = read_unsigned(&tx, 3).unwrap();
        let pubkey_hash = hash160(&PUBKEY);
        assert_eq!(hashes(&parsed), sighashes(&read, &[100_000], &pubkey_hash));
        assert_ne!(hashes(&parsed), sighashes(&read, &[100_001], &pubkey_hash));
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(512))]

        /// Flips bytes of an allowed spend. It is refused, or it still pays only listed payees
        /// within the fee cap, and it never reuses a signing hash, so no signature carries over.
        #[test]
        fn prop_mutated_allowed_tx_never_changes_payments_silently(
            flips in proptest::collection::vec((0usize..400, 1u8..=255), 1..4),
        ) {
            let (prev, txid) = coin();
            let original = unsigned(
                &[(txid, 0)],
                &[(40_000, payee_script()), (59_000, own_script())],
            );
            let allowed = run(&original, &[&prev]).unwrap();
            let mut mutated = original.clone();
            for (index, mask) in flips {
                let index = index % mutated.len();
                mutated[index] ^= mask;
            }
            proptest::prop_assume!(mutated != original);
            if let Ok(parsed) = run(&mutated, &[&prev]) {
                let listed = payee_script();
                proptest::prop_assert!(parsed.payments.iter().all(|p| p.to == listed));
                proptest::prop_assert!(
                    parsed.fee <= policy().btc_max_fee_rate as u128 * parsed.vsize as u128
                );
                proptest::prop_assert_ne!(hashes(&parsed), hashes(&allowed));
            }
        }
    }
}

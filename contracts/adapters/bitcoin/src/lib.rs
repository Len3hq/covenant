//! Bitcoin adapter: P2WPKH vault inputs, SIGHASH_ALL, allow-listed outputs, change to the vault.
//! See docs/SPEC.md, "Bitcoin adapter spec", and corrections C1 and C2 in docs/BUILD_PLAN.md.

use covenant_policy::{AssetId, ChainKind, CovenantError, ParsedTx, Payment, Policy, TxMeta};
use near_sdk::env;
use near_sdk::json_types::U128;

const MAX_OUTPUTS: u64 = 8;
const MIN_OUTPUT_SATS: u64 = 330;
const OP_RETURN: u8 = 0x6a;

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

struct Outpoint<'a> {
    txid: &'a [u8],
    vout: u32,
}

fn double_sha256(bytes: &[u8]) -> [u8; 32] {
    env::sha256_array(env::sha256_array(bytes))
}

fn vault_script(pubkey: &[u8; 33]) -> Vec<u8> {
    let mut script = vec![0x00, 0x14];
    script.extend(env::ripemd160_array(env::sha256_array(pubkey)));
    script
}

/// Finds the output an input spends, after proving `prev_tx` is the transaction it names.
///
/// A serialized outpoint holds the txid in the same byte order the hash produces, so the two
/// compare directly (C1). A witness-serialized prev tx is refused because it can't hash to its
/// txid (C2); the agent strips witness data first.
fn spent_output<'a>(prev_tx: &'a [u8], outpoint: &Outpoint) -> Result<Output<'a>, CovenantError> {
    if prev_tx.get(4) == Some(&0) {
        return Err(CovenantError::MalformedTx);
    }
    if double_sha256(prev_tx) != outpoint.txid {
        return Err(CovenantError::PrevTxMismatch);
    }

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
        if index == outpoint.vout as u64 {
            spent = Some(output);
        }
    }
    reader.take(4)?;
    reader.finish()?;
    spent.ok_or(CovenantError::InputNotOwned)
}

/// Parses an unsigned transaction into its payments and fee, enforcing spec rules 1 to 5.
///
/// `signing_hashes` stays empty until the BIP143 sighash lands in M2. The vault doesn't call this
/// yet, and `propose_spend` still fails closed.
pub fn parse(
    tx: &[u8],
    meta: &TxMeta,
    policy: &Policy,
    vault: &BitcoinVault<'_>,
) -> Result<ParsedTx, CovenantError> {
    let TxMeta::Bitcoin { prev_txs } = meta else {
        return Err(CovenantError::MalformedTx);
    };

    // Rule 1. A zero input count is also how a witness marker reads, so both land here.
    let mut reader = Reader { bytes: tx };
    if !matches!(reader.u32_le()?, 1 | 2) {
        return Err(CovenantError::MalformedTx);
    }
    let input_count = reader.varint()?;
    if input_count == 0 {
        return Err(CovenantError::MalformedTx);
    }
    if input_count > policy.btc_max_inputs as u64 {
        return Err(CovenantError::TooManyInputs);
    }
    let mut outpoints: Vec<Outpoint> = Vec::new();
    for _ in 0..input_count {
        let txid = reader.take(32)?;
        let vout = reader.u32_le()?;
        if !reader.script()?.is_empty() {
            return Err(CovenantError::MalformedTx);
        }
        reader.take(4)?;
        if outpoints.iter().any(|o| o.txid == txid && o.vout == vout) {
            return Err(CovenantError::MalformedTx);
        }
        outpoints.push(Outpoint { txid, vout });
    }
    let output_count = reader.varint()?;
    if output_count == 0 || output_count > MAX_OUTPUTS {
        return Err(CovenantError::MalformedTx);
    }
    let mut outputs = Vec::new();
    for _ in 0..output_count {
        outputs.push(reader.output()?);
    }
    if reader.u32_le()? != 0 {
        return Err(CovenantError::MalformedTx);
    }
    reader.finish()?;

    // Rule 2. `prev_txs` lines up with the inputs, one for each.
    if prev_txs.len() != outpoints.len() {
        return Err(CovenantError::PrevTxMismatch);
    }
    let own_script = vault_script(vault.pubkey);
    let mut total_in: u64 = 0;
    for (outpoint, prev_tx) in outpoints.iter().zip(prev_txs) {
        let spent = spent_output(&prev_tx.0, outpoint)?;
        if spent.script != own_script.as_slice() {
            return Err(CovenantError::InputNotOwned);
        }
        total_in = total_in
            .checked_add(spent.amount)
            .ok_or(CovenantError::MalformedTx)?;
    }

    // Rule 3.
    let mut payments = Vec::new();
    let mut total_out: u64 = 0;
    for output in &outputs {
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
    let weight = 4 * tx.len() as u128 + 2 + 108 * input_count as u128;
    let vsize = weight.div_ceil(4);
    if fee as u128 > policy.btc_max_fee_rate as u128 * vsize {
        return Err(CovenantError::FeeTooHigh);
    }

    Ok(ParsedTx {
        payments,
        fee: fee as u128,
        signing_hashes: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use covenant_policy::Payee;
    use near_sdk::serde_json::{self, Value};

    const PUBKEY: [u8; 33] = [0x02; 33];
    const FUNDING: &str = include_str!("../../../../tests/vectors/btc_testnet4_funding.json");

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
        vault_script(&PUBKEY)
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
}

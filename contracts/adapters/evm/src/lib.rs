//! EVM adapter: EIP-1559 only, native transfer or one exact ERC-20 `transfer`.
//! See docs/SPEC.md, "EVM adapter spec".

use covenant_policy::{AssetId, ChainKind, CovenantError, ParsedTx, Payment, Policy};
use near_sdk::env;
use near_sdk::json_types::U128;

const TYPE_EIP1559: u8 = 0x02;
const FIELD_COUNT: usize = 9;
const TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const TRANSFER_CALLDATA_LEN: usize = 68;

#[derive(Clone, Copy)]
enum Item<'a> {
    Bytes(&'a [u8]),
    List(&'a [u8]),
}

/// Reads a length of `size` bytes that must be minimal and need the long form.
fn long_length(bytes: &[u8], size: usize) -> Result<(usize, &[u8]), CovenantError> {
    if size > bytes.len() || size > std::mem::size_of::<usize>() {
        return Err(CovenantError::MalformedTx);
    }
    let (encoded, rest) = bytes.split_at(size);
    if encoded[0] == 0 {
        return Err(CovenantError::MalformedTx);
    }
    let length = encoded
        .iter()
        .fold(0usize, |value, byte| value << 8 | *byte as usize);
    if length < 56 {
        return Err(CovenantError::MalformedTx);
    }
    Ok((length, rest))
}

/// Decodes one canonical RLP item, returning it and the bytes after it.
fn next_item(bytes: &[u8]) -> Result<(Item<'_>, &[u8]), CovenantError> {
    let (&prefix, rest) = bytes.split_first().ok_or(CovenantError::MalformedTx)?;
    let (is_list, length, rest) = match prefix {
        0x00..=0x7f => return Ok((Item::Bytes(&bytes[..1]), rest)),
        0x80..=0xb7 => (false, (prefix - 0x80) as usize, rest),
        0xb8..=0xbf => {
            let (length, rest) = long_length(rest, (prefix - 0xb7) as usize)?;
            (false, length, rest)
        }
        0xc0..=0xf7 => (true, (prefix - 0xc0) as usize, rest),
        0xf8..=0xff => {
            let (length, rest) = long_length(rest, (prefix - 0xf7) as usize)?;
            (true, length, rest)
        }
    };
    if length > rest.len() {
        return Err(CovenantError::MalformedTx);
    }
    let (payload, rest) = rest.split_at(length);
    if is_list {
        return Ok((Item::List(payload), rest));
    }
    // A single byte below 0x80 is its own encoding.
    if prefix == 0x81 && payload[0] < 0x80 {
        return Err(CovenantError::MalformedTx);
    }
    Ok((Item::Bytes(payload), rest))
}

fn bytes_of(item: Item<'_>) -> Result<&[u8], CovenantError> {
    match item {
        Item::Bytes(bytes) => Ok(bytes),
        Item::List(_) => Err(CovenantError::MalformedTx),
    }
}

/// A canonical RLP integer: no leading zeros, and zero is empty.
fn integer(item: Item<'_>) -> Result<u128, CovenantError> {
    let bytes = bytes_of(item)?;
    if bytes.len() > 16 || bytes.first() == Some(&0) {
        return Err(CovenantError::MalformedTx);
    }
    Ok(bytes
        .iter()
        .fold(0u128, |value, byte| value << 8 | *byte as u128))
}

fn integer_u64(item: Item<'_>) -> Result<u64, CovenantError> {
    u64::try_from(integer(item)?).map_err(|_| CovenantError::MalformedTx)
}

fn fields(tx: &[u8]) -> Result<[Item<'_>; FIELD_COUNT], CovenantError> {
    let (first, rest) = tx.split_first().ok_or(CovenantError::MalformedTx)?;
    if *first != TYPE_EIP1559 {
        return Err(CovenantError::MalformedTx);
    }
    let (outer, trailing) = next_item(rest)?;
    let Item::List(mut payload) = outer else {
        return Err(CovenantError::MalformedTx);
    };
    if !trailing.is_empty() {
        return Err(CovenantError::MalformedTx);
    }
    let mut items = [Item::Bytes(&[]); FIELD_COUNT];
    for slot in &mut items {
        let (item, rest) = next_item(payload)?;
        *slot = item;
        payload = rest;
    }
    if !payload.is_empty() {
        return Err(CovenantError::MalformedTx);
    }
    Ok(items)
}

/// Parses an unsigned type-2 transaction into its payment, maximum gas cost and signing hash,
/// enforcing spec rules 1 to 7.
///
/// Rule 1 makes `tx` the only encoding of its fields, so `0x02 ‖ rlp(fields)` is `tx` itself and
/// the hash covers exactly the bytes that were checked.
pub fn parse(tx: &[u8], policy: &Policy) -> Result<ParsedTx, CovenantError> {
    // Rule 1.
    let [chain_id, nonce, max_priority_fee, max_fee, gas_limit, to, value, data, access_list] =
        fields(tx)?;
    let chain_id = integer_u64(chain_id)?;
    integer_u64(nonce)?;
    let max_priority_fee = integer(max_priority_fee)?;
    let max_fee = integer(max_fee)?;
    let gas_limit = integer(gas_limit)?;
    let to: [u8; 20] = bytes_of(to)?
        .try_into()
        .map_err(|_| CovenantError::MalformedTx)?;
    let value = integer(value)?;
    let data = bytes_of(data)?;
    if !matches!(access_list, Item::List([])) {
        return Err(CovenantError::MalformedTx);
    }

    // Rule 2.
    if !policy.evm_chain_ids.contains(&chain_id) {
        return Err(CovenantError::WrongChainId);
    }

    // Rule 3.
    if max_priority_fee > max_fee {
        return Err(CovenantError::MalformedTx);
    }
    let gas_cost = gas_limit
        .checked_mul(max_fee)
        .filter(|cost| *cost <= policy.evm_max_gas_cost.0)
        .ok_or(CovenantError::GasCostTooHigh)?;

    // Rules 4, 5 and 6.
    let payment = if data.is_empty() {
        if value == 0 {
            return Err(CovenantError::CalldataNotAllowed);
        }
        Payment {
            asset: AssetId::EvmNative { chain_id },
            to: to.to_vec(),
            amount: U128(value),
        }
    } else {
        token_transfer(chain_id, &to, value, data, policy)?
    };

    // Rule 7.
    let listed = policy
        .payees
        .iter()
        .any(|p| p.chain == ChainKind::Evm && p.to == payment.to);
    if !listed {
        return Err(CovenantError::OutputNotWhitelisted);
    }

    Ok(ParsedTx {
        payments: vec![payment],
        fee: gas_cost,
        fee_asset: AssetId::EvmNative { chain_id },
        signing_hashes: vec![env::keccak256_array(tx)],
        vsize: 0,
    })
}

/// Shape B. Anything but an exact `transfer(address,uint256)` is refused, which covers `approve`,
/// `transferFrom`, `permit` and multicalls.
fn token_transfer(
    chain_id: u64,
    token: &[u8; 20],
    value: u128,
    data: &[u8],
    policy: &Policy,
) -> Result<Payment, CovenantError> {
    if data.len() != TRANSFER_CALLDATA_LEN || data[..4] != TRANSFER_SELECTOR {
        return Err(CovenantError::CalldataNotAllowed);
    }
    // Both ABI words must be clean: padding above the address, and an amount that fits a u128.
    if data[4..16].iter().any(|byte| *byte != 0) || data[36..52].iter().any(|byte| *byte != 0) {
        return Err(CovenantError::CalldataNotAllowed);
    }
    if value != 0 {
        return Err(CovenantError::ValueWithTokenCall);
    }
    let asset = AssetId::Erc20 {
        chain_id,
        token: *token,
    };
    if !policy.caps.iter().any(|cap| cap.asset == asset) {
        return Err(CovenantError::TokenNotAllowed);
    }
    let amount = data[52..68]
        .iter()
        .fold(0u128, |amount, byte| amount << 8 | *byte as u128);
    Ok(Payment {
        asset,
        to: data[16..36].to_vec(),
        amount: U128(amount),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use covenant_policy::{AssetCap, Payee};
    use near_sdk::serde_json::{self, Value};

    const CHAIN: u64 = 84532;
    const USDC: [u8; 20] = [0x03; 20];
    const PAYEE: [u8; 20] = [0xaa; 20];
    const STRANGER: [u8; 20] = [0xbb; 20];
    const MAX_GAS_COST: u128 = 1_000_000_000_000_000;
    const VECTORS: &str = include_str!("../../../../tests/vectors/evm_hash.json");

    fn policy() -> Policy {
        Policy {
            caps: vec![AssetCap {
                asset: AssetId::Erc20 {
                    chain_id: CHAIN,
                    token: USDC,
                },
                per_tx: U128(50_000_000),
                per_24h: U128(200_000_000),
                queue_at: U128(25_000_000),
            }],
            payees: vec![Payee {
                chain: ChainKind::Evm,
                to: PAYEE.to_vec(),
                label: "supplier".into(),
            }],
            btc_max_fee_rate: 50,
            btc_max_inputs: 3,
            evm_chain_ids: vec![CHAIN],
            evm_max_gas_cost: U128(MAX_GAS_COST),
            veto_delay_ns: 1,
        }
    }

    fn rlp_length(base: u8, length: usize) -> Vec<u8> {
        if length < 56 {
            return vec![base + length as u8];
        }
        let encoded: Vec<u8> = length
            .to_be_bytes()
            .into_iter()
            .skip_while(|byte| *byte == 0)
            .collect();
        let mut prefix = vec![base + 55 + encoded.len() as u8];
        prefix.extend(encoded);
        prefix
    }

    fn rlp_bytes(bytes: &[u8]) -> Vec<u8> {
        if bytes.len() == 1 && bytes[0] < 0x80 {
            return bytes.to_vec();
        }
        [rlp_length(0x80, bytes.len()), bytes.to_vec()].concat()
    }

    fn rlp_int(value: u128) -> Vec<u8> {
        let bytes: Vec<u8> = value
            .to_be_bytes()
            .into_iter()
            .skip_while(|byte| *byte == 0)
            .collect();
        rlp_bytes(&bytes)
    }

    fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
        let payload = items.concat();
        [rlp_length(0xc0, payload.len()), payload].concat()
    }

    fn transfer_data(selector: [u8; 4], to: [u8; 20], amount: u128) -> Vec<u8> {
        let mut data = selector.to_vec();
        data.extend([0; 12]);
        data.extend(to);
        data.extend([0; 16]);
        data.extend(amount.to_be_bytes());
        data
    }

    #[derive(Clone)]
    struct Tx {
        chain_id: u128,
        priority_fee: u128,
        max_fee: u128,
        gas_limit: u128,
        to: Vec<u8>,
        value: u128,
        data: Vec<u8>,
    }

    impl Tx {
        fn native() -> Self {
            Tx {
                chain_id: CHAIN as u128,
                priority_fee: 1_000,
                max_fee: 1_000_000,
                gas_limit: 21_000,
                to: PAYEE.to_vec(),
                value: 5_000,
                data: vec![],
            }
        }

        fn usdc() -> Self {
            Tx {
                to: USDC.to_vec(),
                value: 0,
                gas_limit: 65_000,
                data: transfer_data(TRANSFER_SELECTOR, PAYEE, 10_000_000),
                ..Tx::native()
            }
        }

        fn items(&self) -> Vec<Vec<u8>> {
            vec![
                rlp_int(self.chain_id),
                rlp_int(7),
                rlp_int(self.priority_fee),
                rlp_int(self.max_fee),
                rlp_int(self.gas_limit),
                rlp_bytes(&self.to),
                rlp_int(self.value),
                rlp_bytes(&self.data),
                rlp_list(&[]),
            ]
        }

        fn encode(&self) -> Vec<u8> {
            typed(0x02, &self.items())
        }
    }

    fn typed(kind: u8, items: &[Vec<u8>]) -> Vec<u8> {
        [vec![kind], rlp_list(items)].concat()
    }

    fn run(tx: &Tx) -> Result<ParsedTx, CovenantError> {
        parse(&tx.encode(), &policy())
    }

    #[test]
    fn evm_accepts_native_transfer_to_payee() {
        let parsed = run(&Tx::native()).unwrap();
        assert_eq!(
            parsed.payments,
            vec![Payment {
                asset: AssetId::EvmNative { chain_id: CHAIN },
                to: PAYEE.to_vec(),
                amount: U128(5_000),
            }]
        );
        assert_eq!(parsed.fee, 21_000 * 1_000_000);
    }

    #[test]
    fn evm_accepts_usdc_transfer_to_payee() {
        let parsed = run(&Tx::usdc()).unwrap();
        assert_eq!(
            parsed.payments,
            vec![Payment {
                asset: AssetId::Erc20 {
                    chain_id: CHAIN,
                    token: USDC,
                },
                to: PAYEE.to_vec(),
                amount: U128(10_000_000),
            }]
        );
        assert_eq!(parsed.fee, 65_000 * 1_000_000);
    }

    #[test]
    fn evm_rejects_approve() {
        let tx = Tx {
            data: transfer_data([0x09, 0x5e, 0xa7, 0xb3], PAYEE, u128::MAX),
            ..Tx::usdc()
        };
        assert_eq!(run(&tx), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn evm_rejects_transfer_from() {
        let mut data = vec![0x23, 0xb8, 0x72, 0xdd];
        data.extend([0; 12]);
        data.extend(STRANGER);
        data.extend(transfer_data([0; 4], PAYEE, 1)[4..].to_vec());
        let tx = Tx { data, ..Tx::usdc() };
        assert_eq!(run(&tx), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn evm_rejects_arbitrary_calldata() {
        let transfer = transfer_data(TRANSFER_SELECTOR, PAYEE, 1);
        let cases = [
            vec![0xde, 0xad],
            transfer[..67].to_vec(),
            [transfer.clone(), vec![0]].concat(),
            [transfer.clone(), transfer].concat(),
        ];
        for data in cases {
            let tx = Tx { data, ..Tx::usdc() };
            assert_eq!(run(&tx), Err(CovenantError::CalldataNotAllowed));
        }
    }

    #[test]
    fn evm_rejects_legacy_type0() {
        let legacy = rlp_list(&Tx::native().items()[1..]);
        assert_eq!(parse(&legacy, &policy()), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn evm_rejects_eip7702_type4() {
        for kind in [0x01, 0x03, 0x04] {
            let tx = typed(kind, &Tx::native().items());
            assert_eq!(parse(&tx, &policy()), Err(CovenantError::MalformedTx));
        }
    }

    #[test]
    fn evm_rejects_wrong_chain_id() {
        let tx = Tx {
            chain_id: 1,
            ..Tx::native()
        };
        assert_eq!(run(&tx), Err(CovenantError::WrongChainId));
    }

    #[test]
    fn evm_rejects_gas_cost_above_cap() {
        let at_cap = Tx {
            gas_limit: 21_000,
            max_fee: MAX_GAS_COST / 21_000,
            ..Tx::native()
        };
        assert!(run(&at_cap).is_ok());

        let over = Tx {
            max_fee: at_cap.max_fee + 1,
            ..at_cap.clone()
        };
        assert_eq!(run(&over), Err(CovenantError::GasCostTooHigh));

        let overflow = Tx {
            gas_limit: u128::MAX,
            max_fee: u128::MAX,
            ..Tx::native()
        };
        assert_eq!(run(&overflow), Err(CovenantError::GasCostTooHigh));
    }

    #[test]
    fn evm_rejects_value_with_token_call() {
        let tx = Tx {
            value: 1,
            ..Tx::usdc()
        };
        assert_eq!(run(&tx), Err(CovenantError::ValueWithTokenCall));
    }

    #[test]
    fn evm_rejects_unlisted_token() {
        let tx = Tx {
            to: STRANGER.to_vec(),
            ..Tx::usdc()
        };
        assert_eq!(run(&tx), Err(CovenantError::TokenNotAllowed));
    }

    #[test]
    fn evm_rejects_unlisted_payee() {
        let native = Tx {
            to: STRANGER.to_vec(),
            ..Tx::native()
        };
        assert_eq!(run(&native), Err(CovenantError::OutputNotWhitelisted));

        let token = Tx {
            data: transfer_data(TRANSFER_SELECTOR, STRANGER, 1),
            ..Tx::usdc()
        };
        assert_eq!(run(&token), Err(CovenantError::OutputNotWhitelisted));
    }

    #[test]
    fn evm_ignores_a_payee_listed_for_another_chain() {
        let mut other_chain = policy();
        other_chain.payees[0].chain = ChainKind::Bitcoin;
        assert_eq!(
            parse(&Tx::native().encode(), &other_chain),
            Err(CovenantError::OutputNotWhitelisted)
        );
    }

    #[test]
    fn evm_rejects_dirty_address_padding() {
        let mut data = transfer_data(TRANSFER_SELECTOR, PAYEE, 1);
        data[15] = 1;
        let tx = Tx { data, ..Tx::usdc() };
        assert_eq!(run(&tx), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn evm_rejects_amount_too_large_for_u128() {
        let mut data = transfer_data(TRANSFER_SELECTOR, PAYEE, 1);
        data[36] = 1;
        let tx = Tx { data, ..Tx::usdc() };
        assert_eq!(run(&tx), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn evm_rejects_empty_transfer() {
        let tx = Tx {
            value: 0,
            ..Tx::native()
        };
        assert_eq!(run(&tx), Err(CovenantError::CalldataNotAllowed));
    }

    #[test]
    fn evm_rejects_non_canonical_rlp() {
        let items = Tx::native().items();
        let with_nonce = |nonce: Vec<u8>| {
            let mut changed = items.clone();
            changed[1] = nonce;
            typed(0x02, &changed)
        };
        let payload = items.concat();

        let cases = [
            ("leading zero", with_nonce(vec![0x82, 0x00, 0x07])),
            ("wrapped single byte", with_nonce(vec![0x81, 0x07])),
            ("zero as a byte", with_nonce(vec![0x00])),
            ("long form for a short string", {
                let mut changed = items.clone();
                changed[7] = vec![0xb8, 0x01, 0xff];
                typed(0x02, &changed)
            }),
            ("long form for a short list", {
                let mut tx = vec![0x02, 0xf8, payload.len() as u8];
                tx.extend(&payload);
                tx
            }),
        ];
        assert!(payload.len() < 56);
        for (name, tx) in cases {
            assert_eq!(
                parse(&tx, &policy()),
                Err(CovenantError::MalformedTx),
                "{name}"
            );
        }
    }

    #[test]
    fn evm_rejects_malformed_shapes() {
        let good = Tx::native().encode();
        let items = Tx::native().items();
        let with = |index: usize, item: Vec<u8>| {
            let mut changed = items.clone();
            changed[index] = item;
            typed(0x02, &changed)
        };
        let cases = [
            ("empty", vec![]),
            ("type byte only", vec![0x02]),
            ("truncated", good[..good.len() - 1].to_vec()),
            ("trailing byte", [good.clone(), vec![0]].concat()),
            ("too few fields", typed(0x02, &items[..8])),
            (
                "too many fields",
                typed(0x02, &[items.clone(), vec![rlp_int(1)]].concat()),
            ),
            ("contract creation", with(5, rlp_bytes(&[]))),
            ("short address", with(5, rlp_bytes(&[0xaa; 19]))),
            ("list as integer", with(0, rlp_list(&[]))),
            ("list as calldata", with(7, rlp_list(&[]))),
            (
                "access list entry",
                with(
                    8,
                    rlp_list(&[rlp_list(&[rlp_bytes(&PAYEE), rlp_list(&[])])]),
                ),
            ),
            ("access list as bytes", with(8, rlp_bytes(&[]))),
            ("nonce above u64", with(1, rlp_int(1u128 << 64))),
            ("value above u128", with(6, rlp_bytes(&[0xff; 17]))),
            (
                "priority fee above max fee",
                Tx {
                    priority_fee: 2_000_000,
                    ..Tx::native()
                }
                .encode(),
            ),
        ];
        for (name, tx) in cases {
            assert_eq!(
                parse(&tx, &policy()),
                Err(CovenantError::MalformedTx),
                "{name}"
            );
        }
    }

    fn hex_field(value: &Value) -> Vec<u8> {
        hex::decode(value.as_str().unwrap()).unwrap()
    }

    /// Every vector goes through the whole of `parse`, which also proves it reads viem's encoding.
    #[test]
    fn evm_hash_matches_viem() {
        let generated: Value = serde_json::from_str(VECTORS).unwrap();
        let vectors = generated["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 5);
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let chain_id = vector["chain_id"].as_u64().unwrap();
            let payee = hex_field(&vector["payee"]);
            let amount: u128 = vector["amount"].as_str().unwrap().parse().unwrap();
            let asset = if vector["token"].is_null() {
                AssetId::EvmNative { chain_id }
            } else {
                AssetId::Erc20 {
                    chain_id,
                    token: hex_field(&vector["token"]).try_into().unwrap(),
                }
            };
            let mut policy = policy();
            policy.evm_chain_ids = vec![chain_id];
            policy.evm_max_gas_cost = U128(u128::MAX);
            policy.payees[0].to = payee.clone();
            policy.caps[0].asset = asset.clone();

            let parsed = parse(&hex_field(&vector["serialized"]), &policy).unwrap();
            let hash: [u8; 32] = hex_field(&vector["hash"]).try_into().unwrap();
            assert_eq!(parsed.signing_hashes, vec![hash], "{name}");
            assert_eq!(
                parsed.payments,
                vec![Payment {
                    asset,
                    to: payee,
                    amount: U128(amount),
                }],
                "{name}"
            );
            let gas_cost: u128 = vector["gas_cost"].as_str().unwrap().parse().unwrap();
            assert_eq!(parsed.fee, gas_cost, "{name}");
        }
    }

    /// The two allowed shapes, stated apart from the parser: no calldata and some value, or exactly
    /// `transfer(address,uint256)` with clean ABI words and no value.
    fn allowed_shape(value: u128, data: &[u8]) -> bool {
        if data.is_empty() {
            return value != 0;
        }
        data.len() == 68
            && data[..4] == [0xa9, 0x05, 0x9c, 0xbb]
            && data[4..16].iter().all(|byte| *byte == 0)
            && data[36..52].iter().all(|byte| *byte == 0)
            && value == 0
    }

    fn calldata() -> impl proptest::strategy::Strategy<Value = Vec<u8>> {
        use proptest::prelude::*;
        let bytes = proptest::collection::vec(any::<u8>(), 0..120);
        let selector = prop_oneof![
            Just(TRANSFER_SELECTOR),
            Just([0x09, 0x5e, 0xa7, 0xb3]),
            Just([0x23, 0xb8, 0x72, 0xdd]),
            any::<[u8; 4]>(),
        ];
        // Near-valid words, so runs often get past the length check and test what follows.
        let shaped = (
            selector,
            (any::<bool>(), any::<[u8; 12]>()),
            (any::<bool>(), any::<[u8; 16]>()),
            any::<u128>(),
        )
            .prop_map(
                |(selector, (clean_address, padding), (clean_amount, high), amount)| {
                    let mut data = selector.to_vec();
                    data.extend(if clean_address { [0; 12] } else { padding });
                    data.extend(PAYEE);
                    data.extend(if clean_amount { [0; 16] } else { high });
                    data.extend(amount.to_be_bytes());
                    data
                },
            );
        prop_oneof![bytes, shaped]
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(1024))]

        #[test]
        fn prop_evm_only_two_shapes_sign(
            data in calldata(),
            value in proptest::prop_oneof![proptest::strategy::Just(0u128), 1u128..1_000],
            to_token in proptest::prelude::any::<bool>(),
        ) {
            let to = if data.is_empty() && !to_token { PAYEE } else { USDC };
            let tx = Tx { to: to.to_vec(), value, data: data.clone(), ..Tx::native() };
            if run(&tx).is_ok() {
                proptest::prop_assert!(allowed_shape(value, &data));
            } else if allowed_shape(value, &data) {
                // The only allowed shape still refused here is a native payment to a non-payee.
                proptest::prop_assert_eq!(to, USDC);
                proptest::prop_assert!(data.is_empty());
            }
        }

        /// Flips bytes of allowed spends. Each is refused, or it still pays a listed payee within
        /// the gas cap, and it never reuses the signing hash.
        #[test]
        fn prop_mutated_allowed_evm_tx_never_pays_elsewhere(
            flips in proptest::collection::vec((0usize..200, 1u8..=255), 1..4),
            token in proptest::prelude::any::<bool>(),
        ) {
            let tx = if token { Tx::usdc() } else { Tx::native() };
            let original = tx.encode();
            let allowed = parse(&original, &policy()).unwrap();
            let mut mutated = original.clone();
            for (index, mask) in flips {
                let index = index % mutated.len();
                mutated[index] ^= mask;
            }
            proptest::prop_assume!(mutated != original);
            if let Ok(parsed) = parse(&mutated, &policy()) {
                proptest::prop_assert!(parsed.payments.iter().all(|p| p.to == PAYEE));
                proptest::prop_assert!(parsed.fee <= MAX_GAS_COST);
                proptest::prop_assert_ne!(parsed.signing_hashes, allowed.signing_hashes);
            }
        }
    }
}

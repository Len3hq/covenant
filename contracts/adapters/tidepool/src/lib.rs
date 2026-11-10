//! Tidepool adapter: checks a swap quote signed by a 1Click-style service, so the vault can pay a
//! deposit address that the service will swap and deliver on another chain. See
//! docs/NEXT_PHASES.md, "Phase 2".
//!
//! The quote's signature is Ed25519, by the maker key, over `sha256(body)`, where `body` is the
//! JSON of `{correlationId, timestamp, quoteRequest, quote}` exactly as the service sent it. The
//! contract hashes the bytes it was given and then parses those same bytes, so every field it reads
//! is a field that was signed. Serde refuses a duplicated field, so one key can't say two things.
//!
//! What this can't check is delivery: the service holds the deposit until it pays out or refunds.
//! That trust is bounded by the vault's caps, and the refund must come back to the vault.

use covenant_policy::{AssetId, ChainKind, CovenantError, SwapInfo, SwapPolicy};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::{bs58, env, near, serde_json};

/// A quote as the service returned it: the signed JSON body and the `ed25519:<base58>` signature.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedQuote {
    pub body: Base64VecU8,
    pub signature: String,
}

/// The vault's own addresses, which a refund must go to.
pub struct VaultAddresses<'a> {
    /// The vault's P2WPKH scriptPubKey.
    pub btc_script: &'a [u8],
    pub evm: &'a [u8; 20],
    pub sol: &'a [u8; 32],
}

/// What the transaction paying the quote must do, and what the swap then commits to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapPlan {
    /// The deposit address in the form the chain's adapter reports a payment's `to`.
    pub deposit_to: Vec<u8>,
    pub amount_in: u128,
    pub origin: AssetId,
    pub info: SwapInfo,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
struct Body {
    correlation_id: String,
    quote_request: Request,
    quote: Quote,
}

/// Every field the vault accepts in a request. Unknown fields are refused, because a field added
/// later, such as an app fee or a forwarding message, could send part of the swap elsewhere.
#[derive(Deserialize)]
#[serde(
    crate = "near_sdk::serde",
    rename_all = "camelCase",
    deny_unknown_fields
)]
#[allow(dead_code)]
struct Request {
    dry: bool,
    #[serde(default)]
    deposit_mode: Option<String>,
    swap_type: String,
    slippage_tolerance: serde_json::Number,
    origin_asset: String,
    deposit_type: String,
    destination_asset: String,
    amount: String,
    refund_to: String,
    refund_type: String,
    recipient: String,
    recipient_type: String,
    deadline: String,
    #[serde(default)]
    referral: Option<String>,
    #[serde(default)]
    quote_waiting_time_ms: Option<serde_json::Number>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    insured: Option<bool>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
struct Quote {
    #[serde(default)]
    deposit_address: Option<String>,
    #[serde(default)]
    deposit_memo: Option<String>,
    amount_in: String,
    min_amount_out: String,
    #[serde(default)]
    deadline: Option<String>,
}

const MISMATCH: CovenantError = CovenantError::QuoteMismatch;

/// Checks a quote for a spend on `chain`, in rule order:
///
/// 1. It is signed by the policy's maker key.
/// 2. It is a live quote that deposits on the origin chain, refunds there and delivers to the
///    destination chain, with an exact input or exact output and no memo.
/// 3. Its refund goes to the vault's own address on `chain`.
/// 4. Its origin and destination assets are listed, and the origin is an asset on `chain`.
/// 5. Its slippage is within the policy's.
/// 6. Its deadline is at least `min_deposit_window_ns` away, and at most a day.
/// 7. Its deposit address is an address on `chain`.
pub fn verify(
    quote: &SignedQuote,
    chain: ChainKind,
    swap: &SwapPolicy,
    vault: &VaultAddresses<'_>,
    now_ns: u64,
) -> Result<SwapPlan, CovenantError> {
    // Rule 1.
    let signature = quote
        .signature
        .strip_prefix("ed25519:")
        .and_then(|text| bs58::decode(text).into_vec().ok())
        .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
        .ok_or(CovenantError::QuoteSignatureInvalid)?;
    let digest = env::sha256_array(&quote.body.0);
    if !env::ed25519_verify(&signature, digest, &swap.maker_key) {
        return Err(CovenantError::QuoteSignatureInvalid);
    }
    let body: Body = serde_json::from_slice(&quote.body.0).map_err(|_| MISMATCH)?;
    let request = &body.quote_request;

    // Rule 2.
    let exact = matches!(request.swap_type.as_str(), "EXACT_INPUT" | "EXACT_OUTPUT");
    let routed = request.deposit_type == "ORIGIN_CHAIN"
        && request.refund_type == "ORIGIN_CHAIN"
        && request.recipient_type == "DESTINATION_CHAIN";
    let simple = request.deposit_mode.as_deref().unwrap_or("SIMPLE") == "SIMPLE"
        && body.quote.deposit_memo.is_none();
    if request.dry || !exact || !routed || !simple {
        return Err(MISMATCH);
    }

    // Rule 3.
    if address_bytes(chain, &request.refund_to)? != own_address(chain, vault) {
        return Err(MISMATCH);
    }

    // Rule 4.
    let origin = swap
        .origins
        .iter()
        .find(|origin| origin.asset_id == request.origin_asset)
        .ok_or(CovenantError::SwapAssetNotAllowed)?;
    if chain_of(&origin.asset) != chain || !swap.destinations.contains(&request.destination_asset) {
        return Err(CovenantError::SwapAssetNotAllowed);
    }

    // Rule 5. A fractional tolerance never reads as an integer, so it is refused too.
    let slippage = request.slippage_tolerance.as_u64().ok_or(MISMATCH)?;
    if slippage > swap.max_slippage_bps as u64 {
        return Err(CovenantError::SlippageTooHigh);
    }

    // Rule 6.
    let deadline = parse_time(body.quote.deadline.as_deref().ok_or(MISMATCH)?)?;
    let earliest = now_ns.saturating_add(swap.min_deposit_window_ns);
    if deadline < earliest || deadline > now_ns.saturating_add(NS_PER_DAY) {
        return Err(CovenantError::QuoteExpired);
    }

    // Rule 7.
    let deposit_address = body.quote.deposit_address.ok_or(MISMATCH)?;
    let deposit_to = address_bytes(chain, &deposit_address)?;
    let amount_in = integer(&body.quote.amount_in)?;
    if amount_in == 0 {
        return Err(MISMATCH);
    }
    Ok(SwapPlan {
        deposit_to,
        amount_in,
        origin: origin.asset.clone(),
        info: SwapInfo {
            correlation_id: body.correlation_id,
            deposit_address,
            destination_asset: request.destination_asset.clone(),
            recipient: request.recipient.clone(),
            min_amount_out: U128(integer(&body.quote.min_amount_out)?),
            deadline_ns: U64(deadline),
        },
    })
}

const NS_PER_DAY: u64 = 86_400_000_000_000;

fn chain_of(asset: &AssetId) -> ChainKind {
    match asset {
        AssetId::Btc => ChainKind::Bitcoin,
        AssetId::EvmNative { .. } | AssetId::Erc20 { .. } => ChainKind::Evm,
        AssetId::Sol | AssetId::Spl { .. } => ChainKind::Solana,
    }
}

fn own_address(chain: ChainKind, vault: &VaultAddresses<'_>) -> Vec<u8> {
    match chain {
        ChainKind::Bitcoin => vault.btc_script.to_vec(),
        ChainKind::Evm => vault.evm.to_vec(),
        ChainKind::Solana => vault.sol.to_vec(),
    }
}

/// An address as the chain's adapter reports it: a scriptPubKey, 20 bytes, or 32 bytes.
pub fn address_bytes(chain: ChainKind, address: &str) -> Result<Vec<u8>, CovenantError> {
    match chain {
        ChainKind::Bitcoin => segwit_script(address, "tb").ok_or(MISMATCH),
        ChainKind::Evm => {
            let digits = address.strip_prefix("0x").ok_or(MISMATCH)?;
            let bytes = hex_decode(digits).ok_or(MISMATCH)?;
            if bytes.len() != 20 {
                return Err(MISMATCH);
            }
            Ok(bytes)
        }
        ChainKind::Solana => {
            let bytes = bs58::decode(address).into_vec().map_err(|_| MISMATCH)?;
            if bytes.len() != 32 {
                return Err(MISMATCH);
            }
            Ok(bytes)
        }
    }
}

fn hex_decode(digits: &str) -> Option<Vec<u8>> {
    if !digits.len().is_multiple_of(2) {
        return None;
    }
    (0..digits.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(digits.get(i..i + 2)?, 16).ok())
        .collect()
}

/// A canonical decimal integer: digits only, no sign, no leading zeros.
fn integer(text: &str) -> Result<u128, CovenantError> {
    let canonical = !text.is_empty()
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    if !canonical {
        return Err(MISMATCH);
    }
    text.parse().map_err(|_| MISMATCH)
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z` as nanoseconds since the epoch. Nothing else is accepted.
pub fn parse_time(text: &str) -> Result<u64, CovenantError> {
    let bytes = text.as_bytes();
    let field = |range: std::ops::Range<usize>| -> Result<u64, CovenantError> {
        let part = text.get(range).ok_or(MISMATCH)?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(MISMATCH);
        }
        part.parse().map_err(|_| MISMATCH)
    };
    let shape = bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes.last() == Some(&b'Z');
    if !shape {
        return Err(MISMATCH);
    }
    let (year, month, day) = (field(0..4)?, field(5..7)?, field(8..10)?);
    let (hour, minute, second) = (field(11..13)?, field(14..16)?, field(17..19)?);
    let mut nanos = 0;
    if bytes.len() > 20 {
        let fraction = text.get(20..bytes.len() - 1).ok_or(MISMATCH)?;
        if bytes[19] != b'.' || fraction.is_empty() || fraction.len() > 9 {
            return Err(MISMATCH);
        }
        nanos = field(20..bytes.len() - 1)? * 10u64.pow(9 - fraction.len() as u32);
    } else if bytes.len() != 20 {
        return Err(MISMATCH);
    }
    let valid = (1970..=9999).contains(&year)
        && (1..=12).contains(&month)
        && (1..=days_in_month(year, month)).contains(&day)
        && hour < 24
        && minute < 60
        && second < 60;
    if !valid {
        return Err(MISMATCH);
    }
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    seconds
        .checked_mul(1_000_000_000)
        .and_then(|ns| ns.checked_add(nanos))
        .ok_or(MISMATCH)
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        2 if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from 1970-01-01, after Howard Hinnant's `days_from_civil`.
fn days_from_civil(year: u64, month: u64, day: u64) -> u64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year / 400;
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32: u32 = 1;
const BECH32M: u32 = 0x2bc8_30a3;

fn polymod(values: impl Iterator<Item = u8>) -> u32 {
    const GENERATOR: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    values.fold(1, |check, value| {
        let top = check >> 25;
        let mut check = ((check & 0x01ff_ffff) << 5) ^ value as u32;
        for (i, generator) in GENERATOR.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                check ^= generator;
            }
        }
        check
    })
}

/// A lowercase segwit address for `hrp` as its scriptPubKey, per BIP173 and BIP350.
pub fn segwit_script(address: &str, hrp: &str) -> Option<Vec<u8>> {
    let (prefix, data) = address.rsplit_once('1')?;
    if prefix != hrp || data.len() < 7 || address.len() > 90 {
        return None;
    }
    let values: Vec<u8> = data
        .bytes()
        .map(|c| CHARSET.iter().position(|&x| x == c).map(|i| i as u8))
        .collect::<Option<_>>()?;
    let expanded = hrp
        .bytes()
        .map(|c| c >> 5)
        .chain([0])
        .chain(hrp.bytes().map(|c| c & 31))
        .chain(values.iter().copied());
    let constant = polymod(expanded);
    let (&version, words) = values[..values.len() - 6].split_first()?;
    if version > 16 || constant != if version == 0 { BECH32 } else { BECH32M } {
        return None;
    }
    // Five-bit groups to bytes, with at most four bits of zero padding left over.
    let mut program = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &word in words {
        acc = (acc << 5) | word as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            program.push((acc >> bits) as u8);
        }
    }
    if bits >= 5 || (acc & ((1 << bits) - 1)) != 0 {
        return None;
    }
    let valid = match version {
        0 => program.len() == 20 || program.len() == 32,
        _ => (2..=40).contains(&program.len()),
    };
    if !valid {
        return None;
    }
    let opcode = if version == 0 { 0 } else { 0x50 + version };
    let mut script = vec![opcode, program.len() as u8];
    script.extend(program);
    Some(script)
}

#[cfg(test)]
mod tests {
    use super::*;
    use covenant_policy::SwapOrigin;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// A live quote from Tidepool on 10 Nov 2026: 20,000 sats to USDC on Base, refunded to the
    /// vault's address in this test, with the maker key it was signed by.
    const LIVE: &str = include_str!("../../../../tests/vectors/tidepool_quote.json");

    fn vector() -> serde_json::Value {
        serde_json::from_str(LIVE).unwrap()
    }

    fn quote() -> SignedQuote {
        let v = vector();
        SignedQuote {
            body: Base64VecU8(v["body"].as_str().unwrap().as_bytes().to_vec()),
            signature: v["signature"].as_str().unwrap().to_string(),
        }
    }

    fn maker_key() -> [u8; 32] {
        let key = vector()["maker_key"].as_str().unwrap().to_string();
        let bytes = bs58::decode(key.strip_prefix("ed25519:").unwrap())
            .into_vec()
            .unwrap();
        bytes.try_into().unwrap()
    }

    fn btc_script() -> Vec<u8> {
        segwit_script(vector()["vault_btc_address"].as_str().unwrap(), "tb").unwrap()
    }

    fn policy() -> SwapPolicy {
        SwapPolicy {
            maker_key: maker_key(),
            origins: vec![SwapOrigin {
                asset_id: "nep141:btc.tp-omft.testnet".into(),
                asset: AssetId::Btc,
            }],
            destinations: vec![
                "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet".into(),
            ],
            payees: vec![],
            max_slippage_bps: 100,
            min_deposit_window_ns: 60_000_000_000,
        }
    }

    /// Ten minutes before the quote's deadline.
    fn now() -> u64 {
        let deadline = vector()["deadline"].as_str().unwrap().to_string();
        parse_time(&deadline).unwrap() - 600_000_000_000
    }

    fn run(quote: &SignedQuote, rules: &SwapPolicy, now: u64) -> Result<SwapPlan, CovenantError> {
        testing_env!(VMContextBuilder::new().build());
        let script = btc_script();
        let vault = VaultAddresses {
            btc_script: &script,
            evm: &[9; 20],
            sol: &[5; 32],
        };
        verify(quote, ChainKind::Bitcoin, rules, &vault, now)
    }

    #[test]
    fn live_quote_verifies_and_names_its_deposit_and_recipient() {
        let plan = run(&quote(), &policy(), now()).unwrap();
        let v = vector();
        assert_eq!(plan.origin, AssetId::Btc);
        assert_eq!(plan.amount_in, 20_000);
        assert_eq!(
            plan.info.deposit_address,
            v["deposit_address"].as_str().unwrap()
        );
        assert_eq!(plan.info.recipient, v["recipient"].as_str().unwrap());
        assert_eq!(
            plan.deposit_to,
            segwit_script(v["deposit_address"].as_str().unwrap(), "tb").unwrap()
        );
        assert_eq!(plan.deposit_to.len(), 22);
    }

    #[test]
    fn one_flipped_byte_fails() {
        let mut changed = quote();
        let index = changed.body.0.len() / 2;
        changed.body.0[index] ^= 1;
        assert_eq!(
            run(&changed, &policy(), now()),
            Err(CovenantError::QuoteSignatureInvalid)
        );
        let mut other_key = policy();
        other_key.maker_key[0] ^= 1;
        assert_eq!(
            run(&quote(), &other_key, now()),
            Err(CovenantError::QuoteSignatureInvalid)
        );
        let mut bad = quote();
        bad.signature = "ed25519:abc".into();
        assert_eq!(
            run(&bad, &policy(), now()),
            Err(CovenantError::QuoteSignatureInvalid)
        );
    }

    #[test]
    fn refund_not_to_vault_fails() {
        testing_env!(VMContextBuilder::new().build());
        let script = segwit_script("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "tb").unwrap();
        let vault = VaultAddresses {
            btc_script: &script,
            evm: &[9; 20],
            sol: &[5; 32],
        };
        assert_eq!(
            verify(&quote(), ChainKind::Bitcoin, &policy(), &vault, now()),
            Err(CovenantError::QuoteMismatch)
        );
    }

    #[test]
    fn deadline_too_close_or_too_far_fails() {
        let deadline = now() + 600_000_000_000;
        let mut strict = policy();
        strict.min_deposit_window_ns = 601_000_000_000;
        assert_eq!(
            run(&quote(), &strict, now()),
            Err(CovenantError::QuoteExpired)
        );
        assert_eq!(
            run(&quote(), &policy(), deadline + 1),
            Err(CovenantError::QuoteExpired)
        );
        assert_eq!(
            run(&quote(), &policy(), deadline - NS_PER_DAY - 1),
            Err(CovenantError::QuoteExpired)
        );
    }

    #[test]
    fn unlisted_assets_and_loose_slippage_fail() {
        let mut no_origin = policy();
        no_origin.origins.clear();
        assert_eq!(
            run(&quote(), &no_origin, now()),
            Err(CovenantError::SwapAssetNotAllowed)
        );
        let mut no_destination = policy();
        no_destination.destinations.clear();
        assert_eq!(
            run(&quote(), &no_destination, now()),
            Err(CovenantError::SwapAssetNotAllowed)
        );
        let mut wrong_chain = policy();
        wrong_chain.origins[0].asset = AssetId::Sol;
        assert_eq!(
            run(&quote(), &wrong_chain, now()),
            Err(CovenantError::SwapAssetNotAllowed)
        );
        let mut tight = policy();
        tight.max_slippage_bps = 99;
        assert_eq!(
            run(&quote(), &tight, now()),
            Err(CovenantError::SlippageTooHigh)
        );
    }

    /// Bodies that aren't the live one can't carry its signature, so these check the parse rules
    /// with a key the test controls: the signature passes, and the shape is what fails.
    mod shape {
        use super::*;

        /// Signs `body` with the test key and returns a policy that trusts that key.
        fn signed(body: &serde_json::Value) -> (SignedQuote, SwapPolicy) {
            let text = serde_json::to_string(body).unwrap();
            test_signed(text)
        }

        fn test_signed(text: String) -> (SignedQuote, SwapPolicy) {
            use near_sdk::env::sha256_array;
            testing_env!(VMContextBuilder::new().build());
            let digest = sha256_array(text.as_bytes());
            let (key, signature) = test_key::sign(&digest);
            let mut rules = policy();
            rules.maker_key = key;
            (
                SignedQuote {
                    body: Base64VecU8(text.into_bytes()),
                    signature: format!("ed25519:{}", bs58::encode(signature).into_string()),
                },
                rules,
            )
        }

        fn live_body() -> serde_json::Value {
            serde_json::from_str(vector()["body"].as_str().unwrap()).unwrap()
        }

        fn refuses(change: impl FnOnce(&mut serde_json::Value), error: CovenantError) {
            let mut body = live_body();
            change(&mut body);
            let (quote, rules) = signed(&body);
            assert_eq!(run(&quote, &rules, now()), Err(error));
        }

        #[test]
        fn the_test_key_accepts_the_live_body() {
            let (quote, rules) = signed(&live_body());
            assert!(run(&quote, &rules, now()).is_ok());
        }

        #[test]
        fn dry_quote_fails() {
            refuses(
                |b| b["quoteRequest"]["dry"] = true.into(),
                CovenantError::QuoteMismatch,
            );
        }

        #[test]
        fn flex_and_any_input_fail() {
            for kind in ["FLEX_INPUT", "ANY_INPUT"] {
                refuses(
                    |b| b["quoteRequest"]["swapType"] = kind.into(),
                    CovenantError::QuoteMismatch,
                );
            }
        }

        #[test]
        fn routing_other_than_chain_to_chain_fails() {
            for field in ["depositType", "refundType", "recipientType"] {
                refuses(
                    |b| b["quoteRequest"][field] = "INTENTS".into(),
                    CovenantError::QuoteMismatch,
                );
            }
        }

        #[test]
        fn memo_and_unknown_request_fields_fail() {
            refuses(
                |b| b["quote"]["depositMemo"] = "1".into(),
                CovenantError::QuoteMismatch,
            );
            for field in [
                "appFees",
                "customRecipientMsg",
                "virtualChainRecipient",
                "rebates",
                "confidentiality",
            ] {
                refuses(
                    |b| b["quoteRequest"][field] = serde_json::json!([]),
                    CovenantError::QuoteMismatch,
                );
            }
        }

        #[test]
        fn duplicate_key_json_fails() {
            let body = serde_json::to_string(&live_body()).unwrap();
            let doubled = body.replacen(
                "\"recipient\":",
                "\"recipient\":\"0x00000000000000000000000000000000000000aa\",\"recipient\":",
                1,
            );
            assert_ne!(doubled, body);
            let (quote, rules) = test_signed(doubled);
            assert_eq!(
                run(&quote, &rules, now()),
                Err(CovenantError::QuoteMismatch)
            );
        }

        #[test]
        fn fractional_slippage_and_odd_amounts_fail() {
            refuses(
                |b| b["quoteRequest"]["slippageTolerance"] = serde_json::json!(50.5),
                CovenantError::QuoteMismatch,
            );
            for amount in ["", "0", "020000", "-1", "1e5"] {
                refuses(
                    |b| b["quote"]["amountIn"] = amount.into(),
                    CovenantError::QuoteMismatch,
                );
            }
        }

        #[test]
        fn deposit_address_on_another_chain_fails() {
            refuses(
                |b| {
                    b["quote"]["depositAddress"] =
                        "0x2527D02599Ba641c19FEa793cD0F167589a0f10D".into()
                },
                CovenantError::QuoteMismatch,
            );
            refuses(
                |b| {
                    b["quote"].as_object_mut().unwrap().remove("depositAddress");
                },
                CovenantError::QuoteMismatch,
            );
        }
    }

    /// A fixed Ed25519 key the tests sign with.
    mod test_key {
        use ed25519_dalek::{Signer, SigningKey};

        pub fn sign(message: &[u8]) -> ([u8; 32], [u8; 64]) {
            let key = SigningKey::from_bytes(&[7; 32]);
            (key.verifying_key().to_bytes(), key.sign(message).to_bytes())
        }
    }

    #[test]
    fn address_bytes_reads_each_chain() {
        assert_eq!(
            address_bytes(ChainKind::Evm, "0x2527D02599Ba641c19FEa793cD0F167589a0f10D").unwrap(),
            hex_decode("2527d02599ba641c19fea793cd0f167589a0f10d").unwrap()
        );
        assert!(address_bytes(ChainKind::Evm, "2527D02599Ba641c19FEa793cD0F167589a0f10D").is_err());
        assert!(address_bytes(ChainKind::Evm, "0x2527").is_err());
        assert_eq!(
            address_bytes(
                ChainKind::Solana,
                "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
            )
            .unwrap()
            .len(),
            32
        );
        assert!(address_bytes(ChainKind::Solana, "0xabc").is_err());
        assert!(address_bytes(
            ChainKind::Bitcoin,
            "0x2527D02599Ba641c19FEa793cD0F167589a0f10D"
        )
        .is_err());
    }

    #[test]
    fn parse_time_reads_iso_utc() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Ok(0));
        assert_eq!(
            parse_time("2026-11-10T16:09:05.000Z"),
            Ok(1_794_326_945_000_000_000)
        );
        assert_eq!(
            parse_time("2024-02-29T00:00:00.5Z"),
            Ok(1_709_164_800_500_000_000)
        );
        for bad in [
            "2026-11-10 16:09:05Z",
            "2026-11-10T16:09:05",
            "2026-02-30T00:00:00Z",
            "2026-11-10T24:00:00Z",
            "2026-11-10T16:09:05.Z",
            "2026-11-10T16:09:05+01:00",
        ] {
            assert_eq!(parse_time(bad), Err(CovenantError::QuoteMismatch), "{bad}");
        }
    }

    #[test]
    fn segwit_script_follows_bip173_and_bip350() {
        // BIP173's test vectors, re-encoded for testnet's `tb` prefix where they're testnet ones.
        assert_eq!(
            segwit_script("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "tb").unwrap(),
            [
                &[0x00, 0x14][..],
                &hex_decode("751e76e8199196d454941c45d1b3a323f1433bd6").unwrap()
            ]
            .concat()
        );
        // BIP350: a taproot output on testnet.
        let taproot = segwit_script(
            "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c",
            "tb",
        )
        .unwrap();
        assert_eq!(&taproot[..2], &[0x51, 0x20]);
        // A v0 address with a bech32m checksum, and a mainnet address, are refused.
        assert_eq!(
            segwit_script(
                "tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47",
                "tb"
            ),
            None
        );
        assert_eq!(
            segwit_script("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "tb"),
            None
        );
        assert_eq!(
            segwit_script("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsy", "tb"),
            None
        );
    }
}

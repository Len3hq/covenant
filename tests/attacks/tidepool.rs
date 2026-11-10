//! Swap attacks by a hijacked agent, sent to the real contract with quotes signed by a test maker
//! key. An honest swap pays exactly the quote's deposit; each attack must end with no signature
//! requested and no budget used.

#[path = "../integration/tests/common/mod.rs"]
mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::result::ExecutionFinalResult;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

const CAPS: BtcCap = BtcCap {
    per_tx: 90_000,
    per_24h: 500_000,
    queue_at: 60_000,
};
const AMOUNT: u64 = 20_000;
const FEE: u64 = 1_000;
const ORIGIN: &str = "nep141:btc.tp-omft.testnet";
const DESTINATION: &str = "nep141:sol.tp-omft.testnet";
const RECIPIENT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/// The sandbox vault's own address, from `PUBKEY`.
const VAULT_ADDRESS: &str = "tb1q2xq57yyxwzkw6tthcxq9mhtxxj7f63e3dgldfj";
const DEPOSIT_ADDRESS: &str = "tb1q0jem8tkxvt4tha2wrqz0lnmf7mg0d6tjquwcv5";
const DEPOSIT_PROGRAM: &str = "7cb3b3aec662eabbf54e1804ffcf69f6d0f6e972";
const HOUR_NS: u64 = 3_600_000_000_000;

fn maker() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

fn deposit_script() -> Vec<u8> {
    [vec![0x00, 0x14], decode_hex(DEPOSIT_PROGRAM)].concat()
}

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

/// Nanoseconds since the epoch as `YYYY-MM-DDTHH:MM:SS.000Z`.
fn iso(ns: u64) -> String {
    let secs = ns / 1_000_000_000;
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// A quote body as Tidepool writes one, depositing `AMOUNT` sats and expiring in `hours`.
fn body(hours: u64) -> Value {
    let deadline = iso(now_ns() + hours * HOUR_NS);
    json!({
        "correlationId": format!("test-{}", now_ns()),
        "timestamp": iso(now_ns()),
        "quoteRequest": {
            "dry": false,
            "swapType": "EXACT_INPUT",
            "slippageTolerance": 100,
            "originAsset": ORIGIN,
            "depositType": "ORIGIN_CHAIN",
            "destinationAsset": DESTINATION,
            "amount": AMOUNT.to_string(),
            "refundTo": VAULT_ADDRESS,
            "refundType": "ORIGIN_CHAIN",
            "recipient": RECIPIENT,
            "recipientType": "DESTINATION_CHAIN",
            "deadline": deadline,
        },
        "quote": {
            "depositAddress": DEPOSIT_ADDRESS,
            "amountIn": AMOUNT.to_string(),
            "amountInFormatted": "0.0002",
            "amountInUsd": "14.72",
            "minAmountIn": AMOUNT.to_string(),
            "amountOut": "98000000",
            "amountOutFormatted": "0.098",
            "amountOutUsd": "14.6",
            "minAmountOut": "97020000",
            "deadline": deadline,
            "timeWhenInactive": deadline,
            "timeEstimate": 60,
        },
    })
}

fn sign(body: &Value) -> Value {
    let text = serde_json::to_string(body).unwrap();
    let digest = Sha256::digest(text.as_bytes());
    let signature = maker().sign(&digest).to_bytes();
    json!({
        "body": STANDARD.encode(text),
        "signature": format!("ed25519:{}", bs58::encode(signature).into_string()),
    })
}

/// A spend paying `amount` to `to`, with `quote` attached.
fn swap_spend(to: &[u8], amount: u64, quote: Value) -> Value {
    let mut spend = bitcoin_proposal(1, 222, to, amount, FEE);
    spend["quote"] = quote;
    spend
}

fn honest(quote: Value) -> Value {
    swap_spend(&deposit_script(), AMOUNT, quote)
}

fn swap_rules(listed: bool) -> Value {
    json!({
        "maker_key": maker().verifying_key().to_bytes().to_vec(),
        "origins": [{ "asset_id": ORIGIN, "asset": "Btc" }],
        "destinations": [DESTINATION],
        "payees": if listed {
            json!([{ "destination_asset": DESTINATION, "recipient": RECIPIENT, "label": "designer" }])
        } else {
            json!([])
        },
        "max_slippage_bps": 100,
        "min_deposit_window_ns": HOUR_NS,
    })
}

async fn set_policy(s: &Setup, change: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let mut policy: Value = s.vault.view("get_policy").await?.json()?;
    change(&mut policy);
    s.owner
        .call(s.vault.id(), "set_policy")
        .args_json(json!({ "policy": policy }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn with_swaps(listed: bool) -> anyhow::Result<Setup> {
    let s = setup(&CAPS).await?;
    set_policy(&s, |policy| policy["swap"] = swap_rules(listed)).await?;
    Ok(s)
}

async fn propose(s: &Setup, spend: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(s.agent
        .call(s.vault.id(), "propose_spend")
        .args_json(spend)
        .max_gas()
        .transact()
        .await?)
}

async fn outcome(s: &Setup, spend: Value) -> anyhow::Result<Value> {
    Ok(propose(s, spend).await?.into_result()?.json()?)
}

async fn signer_calls(s: &Setup) -> anyhow::Result<u64> {
    Ok(s.signer.view("get_calls").await?.json()?)
}

async fn spent(s: &Setup) -> anyhow::Result<u64> {
    let text: String = s
        .vault
        .view("get_spent_24h")
        .args_json(json!({ "asset": "Btc" }))
        .await?
        .json()?;
    Ok(text.parse()?)
}

/// The attack is refused with `error`, nothing is signed and no budget is used.
async fn refused(s: &Setup, spend: Value, error: &str) -> anyhow::Result<()> {
    assert_eq!(outcome(s, spend).await?, json!({ "Rejected": error }));
    assert_eq!(signer_calls(s).await?, 0);
    assert_eq!(spent(s).await?, 0);
    Ok(())
}

#[tokio::test]
async fn honest_swap_to_a_listed_recipient_signs_and_logs_the_swap() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let quote_body = body(3);
    let result = propose(&s, honest(sign(&quote_body))).await?;
    let event = result
        .logs()
        .iter()
        .find(|log| log.contains("spend_signed"))
        .map(|log| log.to_string())
        .expect("a spend_signed event");
    let value: Value = result.into_result()?.json()?;
    assert!(value.get("Signed").is_some(), "{value}");
    assert!(
        event.contains(RECIPIENT) && event.contains(DESTINATION),
        "{event}"
    );
    assert_eq!(signer_calls(&s).await?, 1);
    assert_eq!(spent(&s).await?, AMOUNT + FEE);
    let used: bool = s
        .vault
        .view("is_quote_used")
        .args_json(json!({ "correlation_id": quote_body["correlationId"] }))
        .await?
        .json()?;
    assert!(used);
    Ok(())
}

#[tokio::test]
async fn attack_replays_a_used_quote() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let quote = sign(&body(3));
    outcome(&s, honest(quote.clone())).await?;
    let value = outcome(&s, honest(quote)).await?;
    assert_eq!(value, json!({ "Rejected": "QuoteReused" }));
    assert_eq!(signer_calls(&s).await?, 1);
    Ok(())
}

#[tokio::test]
async fn attack_pays_its_own_address_with_an_honest_quote() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let spend = swap_spend(&stranger_script(), AMOUNT, sign(&body(3)));
    refused(&s, spend, "OutputNotWhitelisted").await
}

#[tokio::test]
async fn attack_changes_the_recipient_after_signing() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let mut quote = sign(&body(3));
    let text = String::from_utf8(STANDARD.decode(quote["body"].as_str().unwrap())?)?;
    let forged = text.replace(RECIPIENT, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    quote["body"] = json!(STANDARD.encode(forged));
    refused(&s, honest(quote), "QuoteSignatureInvalid").await
}

#[tokio::test]
async fn attack_sends_the_refund_to_itself() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let mut quote_body = body(3);
    quote_body["quoteRequest"]["refundTo"] = json!("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
    refused(&s, honest(sign(&quote_body)), "QuoteMismatch").await
}

#[tokio::test]
async fn attack_deposits_more_than_the_quote() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let spend = swap_spend(&deposit_script(), AMOUNT + 1, sign(&body(3)));
    refused(&s, spend, "QuoteMismatch").await
}

#[tokio::test]
async fn attack_uses_a_dry_quote() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let mut quote_body = body(3);
    quote_body["quoteRequest"]["dry"] = json!(true);
    refused(&s, honest(sign(&quote_body)), "QuoteMismatch").await
}

#[tokio::test]
async fn attack_adds_an_app_fee_to_itself() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let mut quote_body = body(3);
    quote_body["quoteRequest"]["appFees"] = json!([{ "recipient": "attacker.near", "fee": 5000 }]);
    refused(&s, honest(sign(&quote_body)), "QuoteMismatch").await
}

#[tokio::test]
async fn attack_swaps_to_an_unlisted_destination_asset() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    let mut quote_body = body(3);
    quote_body["quoteRequest"]["destinationAsset"] = json!("nep141:wnear.tidepool-sandbox.testnet");
    refused(&s, honest(sign(&quote_body)), "SwapAssetNotAllowed").await
}

#[tokio::test]
async fn swaps_are_refused_without_a_swap_section() -> anyhow::Result<()> {
    let s = setup(&CAPS).await?;
    refused(&s, honest(sign(&body(3))), "SwapsDisabled").await
}

#[tokio::test]
async fn swap_to_an_unlisted_recipient_follows_the_unlisted_rules() -> anyhow::Result<()> {
    let s = with_swaps(false).await?;
    refused(&s, honest(sign(&body(3))), "OutputNotWhitelisted").await?;

    set_policy(&s, |policy| {
        policy["unlisted"] = json!("Hold");
        policy["unlisted_veto_delay_ns"] = json!(HOUR_NS);
        policy["caps"][0]["unlisted_per_24h"] = json!("50000");
    })
    .await?;
    let held = outcome(&s, honest(sign(&body(3)))).await?;
    assert!(held.get("Queued").is_some(), "{held}");
    assert_eq!(signer_calls(&s).await?, 0);

    // A quote that would expire before the window ends, plus the deposit time, is refused.
    let short = outcome(&s, honest(sign(&body(2)))).await?;
    assert_eq!(short, json!({ "Rejected": "QuoteExpiresInQueue" }));
    Ok(())
}

#[tokio::test]
async fn held_swap_rechecks_the_swap_rules_at_execute() -> anyhow::Result<()> {
    let s = with_swaps(true).await?;
    // Large enough to queue under the main caps, with no wait.
    set_policy(&s, |policy| {
        policy["veto_delay_ns"] = json!(0);
        policy["caps"][0]["queue_at"] = json!("1000");
    })
    .await?;
    let held = outcome(&s, honest(sign(&body(3)))).await?;
    let id = held["Queued"]["id"].as_str().unwrap().to_string();
    set_policy(&s, |policy| policy["swap"]["destinations"] = json!([])).await?;
    let value: Value = s
        .agent
        .call(s.vault.id(), "execute")
        .args_json(json!({ "id": id }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(value, json!({ "Rejected": "SwapAssetNotAllowed" }));
    assert_eq!(signer_calls(&s).await?, 0);
    assert_eq!(spent(&s).await?, 0);
    Ok(())
}

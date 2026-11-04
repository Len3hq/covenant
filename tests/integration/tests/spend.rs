//! `propose_spend` end to end against the mock signer, whose signatures echo the payload.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use serde_json::{json, Value};

const PAYMENT: u64 = 50_000;
const FEE: u64 = 10_000;

fn honest_spend(inputs: u8) -> Value {
    bitcoin_proposal(inputs, 222, &payee_script(), PAYMENT, FEE)
}

async fn propose(s: &Setup, args: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(s.agent
        .call(s.vault.id(), "propose_spend")
        .args_json(args)
        .max_gas()
        .transact()
        .await?)
}

async fn spent(s: &Setup, asset: Value) -> anyhow::Result<String> {
    Ok(s.vault
        .view("get_spent_24h")
        .args_json(json!({ "asset": asset }))
        .await?
        .json()?)
}

async fn signer_calls(s: &Setup) -> anyhow::Result<u64> {
    Ok(s.signer.view("get_calls").await?.json()?)
}

fn logged(outcome: &ExecutionFinalResult, text: &str) -> bool {
    outcome.logs().iter().any(|log| log.contains(text))
}

#[tokio::test]
async fn bitcoin_spend_is_signed_and_charged() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    let outcome = propose(&s, honest_spend(2)).await?;
    assert!(logged(&outcome, "spend_proposed"));
    assert!(logged(&outcome, "spend_signed"));
    let result: Value = outcome.into_result()?.json()?;

    let signatures = result["Signed"]["signatures"].as_array().unwrap();
    assert_eq!(result["Signed"]["id"], "0");
    assert_eq!(signatures.len(), 2);
    assert_ne!(signatures[0]["s"], signatures[1]["s"]);
    assert_eq!(signer_calls(&s).await?, 2);
    assert_eq!(spent(&s, json!("Btc")).await?, (PAYMENT + FEE).to_string());
    Ok(())
}

/// The mock echoes what it was asked to sign, so this shows the vault requested viem's hash.
#[tokio::test]
async fn evm_spend_signs_the_hash_the_contract_computed() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    let vector = evm_vector();
    let result: Value = propose(&s, evm_proposal()).await?.into_result()?.json()?;

    let signatures = result["Signed"]["signatures"].as_array().unwrap();
    assert_eq!(signatures.len(), 1);
    assert_eq!(signatures[0]["s"]["scalar"], vector["hash"]);

    let usdc = decode_hex(vector["token"].as_str().unwrap());
    let token = json!({ "Erc20": { "chain_id": 84532, "token": usdc } });
    assert_eq!(spent(&s, token).await?, vector["amount"].as_str().unwrap());
    let gas = json!({ "EvmNative": { "chain_id": 84532 } });
    assert_ne!(spent(&s, gas).await?, "0");
    Ok(())
}

#[tokio::test]
async fn rejection_emits_event_without_state_change() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    let attack = bitcoin_proposal(1, 222, &stranger_script(), PAYMENT, FEE);
    let outcome = propose(&s, attack).await?;
    assert!(logged(&outcome, "spend_rejected"));
    assert!(logged(&outcome, "OutputNotWhitelisted"));
    let result: Value = outcome.into_result()?.json()?;

    assert_eq!(result, json!({ "Rejected": "OutputNotWhitelisted" }));
    assert_eq!(signer_calls(&s).await?, 0);
    assert_eq!(spent(&s, json!("Btc")).await?, "0");

    // The refused proposal didn't use up an id.
    let next: Value = propose(&s, honest_spend(1)).await?.into_result()?.json()?;
    assert_eq!(next["Signed"]["id"], "0");
    Ok(())
}

#[tokio::test]
async fn daily_cap_holds_across_spends() -> anyhow::Result<()> {
    let cap = BtcCap {
        per_tx: 100_000,
        per_24h: 2 * (PAYMENT + FEE),
        queue_at: 100_000,
    };
    let s = setup(&cap).await?;
    for _ in 0..2 {
        let result: Value = propose(&s, honest_spend(1)).await?.into_result()?.json()?;
        assert!(result.get("Signed").is_some());
    }
    let result: Value = propose(&s, honest_spend(1)).await?.into_result()?.json()?;
    assert_eq!(result, json!({ "Rejected": "DailyCapExceeded" }));
    assert_eq!(signer_calls(&s).await?, 2);
    Ok(())
}

#[tokio::test]
async fn sign_failure_releases_reservation() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;

    // Total failure: every `sign` in the join fails.
    s.signer
        .call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let total = propose(&s, honest_spend(1)).await?;
    assert!(logged(&total, "SignFailed"));
    let result: Value = total.json()?;
    assert_eq!(result, json!({ "Rejected": "SignFailed" }));
    assert_eq!(spent(&s, json!("Btc")).await?, "0");

    // Partial failure: the first input is signed and the second isn't.
    s.signer
        .call("set_fail")
        .args_json(json!({ "fail": false }))
        .transact()
        .await?
        .into_result()?;
    s.signer
        .call("set_fail_after")
        .args_json(json!({ "calls": 1 }))
        .transact()
        .await?
        .into_result()?;
    let partial = propose(&s, honest_spend(2)).await?;
    let result: Value = partial.json()?;
    assert_eq!(result, json!({ "Rejected": "SignFailed" }));
    assert_eq!(signer_calls(&s).await?, 1);
    assert_eq!(spent(&s, json!("Btc")).await?, "0");
    Ok(())
}

#[tokio::test]
async fn spend_needing_the_veto_window_is_refused_until_the_queue_exists() -> anyhow::Result<()> {
    let cap = BtcCap {
        per_tx: 100_000,
        per_24h: 500_000,
        queue_at: PAYMENT,
    };
    let s = setup(&cap).await?;
    let failure = format!("{:?}", propose(&s, honest_spend(1)).await?.into_result());
    assert!(failure.contains("queue not implemented"), "{failure}");
    assert_eq!(signer_calls(&s).await?, 0);
    assert_eq!(spent(&s, json!("Btc")).await?, "0");
    Ok(())
}

#[tokio::test]
async fn only_the_vault_can_call_on_signed() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    propose(&s, honest_spend(1)).await?.into_result()?;
    let args = json!({
        "id": "0",
        "count": 0,
        "chain": "Bitcoin",
        "payments": [],
        "fee": "0",
        "charges": [{ "asset": "Btc", "amount": (PAYMENT + FEE).to_string() }],
        "at": "0",
    });
    for caller in [&s.agent, &s.owner, &s.guardian] {
        let outcome = caller
            .call(s.vault.id(), "on_signed")
            .args_json(&args)
            .max_gas()
            .transact()
            .await?;
        let failure = format!("{:?}", outcome.into_result().unwrap_err());
        assert!(failure.contains("private"), "{failure}");
    }
    Ok(())
}

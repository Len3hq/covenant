//! Solana spends end to end against the mock signer, whose Ed25519 signature is a hash of exactly
//! the message it was asked to sign.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const LAMPORTS: u64 = 1_000_000;
const BASE_FEE: u64 = 5_000;

async fn call(
    s: &Setup,
    who: &near_workspaces::Account,
    method: &str,
    args: Value,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(s.vault.id(), method)
        .args_json(args)
        .max_gas()
        .transact()
        .await?)
}

async fn propose(s: &Setup, message: &SolMessage) -> anyhow::Result<Value> {
    Ok(call(s, &s.agent, "propose_spend", message.proposal())
        .await?
        .into_result()?
        .json()?)
}

async fn spent(s: &Setup, asset: Value) -> anyhow::Result<String> {
    Ok(s.vault
        .view("get_spent_24h")
        .args_json(json!({ "asset": asset }))
        .await?
        .json()?)
}

async fn change_policy(s: &Setup, change: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let mut policy: Value = s.vault.view("get_policy").await?.json()?;
    change(&mut policy);
    call(s, &s.owner, "set_policy", json!({ "policy": policy }))
        .await?
        .into_result()?;
    Ok(())
}

/// What the mock returns for an Ed25519 request over `message`.
fn mock_signature(message: &[u8]) -> Vec<u8> {
    let first = Sha256::digest(message);
    [first.to_vec(), Sha256::digest(first).to_vec()].concat()
}

fn signed_bytes(result: &Value) -> Vec<u8> {
    let signature = &result["Signed"]["signatures"][0];
    assert_eq!(signature["scheme"], "Ed25519", "{result}");
    signature["signature"]
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| byte.as_u64().unwrap() as u8)
        .collect()
}

#[tokio::test]
async fn solana_spend_signs_the_message_the_contract_checked() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    let message = SolMessage::new().sol(SOL_VAULT, SOL_PAYEE, LAMPORTS);
    let result = propose(&s, &message).await?;
    assert_eq!(result["Signed"]["signatures"].as_array().unwrap().len(), 1);
    assert_eq!(signed_bytes(&result), mock_signature(&message.bytes()));
    assert_eq!(
        spent(&s, json!("Sol")).await?,
        (LAMPORTS + BASE_FEE).to_string()
    );

    let addresses: Value = s.vault.view("get_addresses").await?.json()?;
    assert_eq!(addresses["sol_address"].as_str().unwrap().len(), 44);
    Ok(())
}

#[tokio::test]
async fn solana_usdc_spend_charges_the_token_and_its_fee() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    let message = SolMessage::new()
        .token(SOL_USDC, SOL_PAYEE_TOKENS, 2_000_000)
        .priority(10_000, 1_000_000);
    let result = propose(&s, &message).await?;
    assert_eq!(signed_bytes(&result), mock_signature(&message.bytes()));
    let usdc = json!({ "Spl": { "mint": SOL_USDC } });
    assert_eq!(spent(&s, usdc).await?, "2000000");
    // 10,000 units at 1 lamport each, plus the base fee.
    assert_eq!(
        spent(&s, json!("Sol")).await?,
        (10_000 + BASE_FEE).to_string()
    );
    Ok(())
}

/// The durable nonce is what lets a queued message still land once its window has passed.
#[tokio::test]
async fn solana_large_spend_queues_then_signs_the_stored_message() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    let message = SolMessage::new().sol(SOL_VAULT, SOL_PAYEE, 60_000_000);
    let queued = propose(&s, &message).await?;
    let id = queued["Queued"]["id"].as_str().unwrap().to_string();
    assert_eq!(s.signer.view("get_calls").await?.json::<u64>()?, 0);
    let early: Value = call(&s, &s.agent, "execute", json!({ "id": id }))
        .await?
        .into_result()?
        .json()?;
    assert_eq!(early, json!({ "Rejected": "NotYetExecutable" }));

    // A spend keeps the window it was queued with, so this one is queued with none.
    change_policy(&s, |policy| policy["veto_delay_ns"] = json!(0)).await?;
    let queued = propose(&s, &message).await?;
    let id = queued["Queued"]["id"].as_str().unwrap().to_string();
    let result: Value = call(&s, &s.agent, "execute", json!({ "id": id }))
        .await?
        .into_result()?
        .json()?;
    assert_eq!(signed_bytes(&result), mock_signature(&message.bytes()));
    Ok(())
}

#[tokio::test]
async fn solana_execute_rechecks_a_tightened_fee_cap() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    change_policy(&s, |policy| policy["veto_delay_ns"] = json!(0)).await?;
    let message = SolMessage::new().sol(SOL_VAULT, SOL_PAYEE, 60_000_000);
    let id = propose(&s, &message).await?["Queued"]["id"].clone();
    change_policy(&s, |policy| policy["sol_max_fee"] = json!("4999")).await?;
    let result: Value = call(&s, &s.agent, "execute", json!({ "id": id }))
        .await?
        .into_result()?
        .json()?;
    assert_eq!(result, json!({ "Rejected": "FeeTooHigh" }));
    assert_eq!(s.signer.view("get_calls").await?.json::<u64>()?, 0);
    Ok(())
}

/// A policy written before Solana support has no `sol_max_fee`, which reads as zero.
#[tokio::test]
async fn policy_without_a_solana_fee_cap_refuses_solana() -> anyhow::Result<()> {
    let s = setup(&ROOMY).await?;
    change_policy(&s, |policy| {
        policy.as_object_mut().unwrap().remove("sol_max_fee");
    })
    .await?;
    let message = SolMessage::new().sol(SOL_VAULT, SOL_PAYEE, LAMPORTS);
    assert_eq!(
        propose(&s, &message).await?,
        json!({ "Rejected": "FeeTooHigh" })
    );
    Ok(())
}

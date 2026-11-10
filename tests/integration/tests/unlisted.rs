//! Open payees: with `unlisted: Hold`, a payment to an address off the list is held for the longer
//! window within its own daily cap, end to end against the mock signer.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::Account;
use serde_json::{json, Value};

const PAYMENT: u64 = 20_000;
const FEE: u64 = 10_000;
/// High enough that every spend here would be signed at once if it went to a listed payee.
const SIGNING: BtcCap = BtcCap {
    per_tx: 100_000,
    per_24h: 500_000,
    queue_at: 100_000,
};
const UNLISTED_CAP: u64 = 50_000;

async fn call(
    who: &Account,
    s: &Setup,
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

async fn change_policy(s: &Setup, change: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let mut policy: Value = s.vault.view("get_policy").await?.json()?;
    change(&mut policy);
    call(&s.owner, s, "set_policy", json!({ "policy": policy }))
        .await?
        .into_result()?;
    Ok(())
}

/// Holds unlisted BTC payees, with `listed_delay` and `unlisted_delay` as the two windows.
async fn open(s: &Setup, listed_delay: u64, unlisted_delay: u64) -> anyhow::Result<()> {
    change_policy(s, |policy| {
        policy["unlisted"] = json!("Hold");
        policy["veto_delay_ns"] = json!(listed_delay);
        policy["unlisted_veto_delay_ns"] = json!(unlisted_delay);
        policy["caps"][0]["unlisted_per_24h"] = json!(UNLISTED_CAP.to_string());
    })
    .await
}

async fn propose(s: &Setup, to: &[u8], amount: u64) -> anyhow::Result<Value> {
    let spend = bitcoin_proposal(1, 222, to, amount, FEE);
    Ok(call(&s.agent, s, "propose_spend", spend)
        .await?
        .into_result()?
        .json()?)
}

async fn view_u64(s: &Setup, method: &str) -> anyhow::Result<u64> {
    let text: String = s
        .vault
        .view(method)
        .args_json(json!({ "asset": "Btc" }))
        .await?
        .json()?;
    Ok(text.parse()?)
}

async fn signer_calls(s: &Setup) -> anyhow::Result<u64> {
    Ok(s.signer.view("get_calls").await?.json()?)
}

#[tokio::test]
async fn refuse_mode_is_the_default() -> anyhow::Result<()> {
    let s = setup(&SIGNING).await?;
    let value = propose(&s, &stranger_script(), PAYMENT).await?;
    assert_eq!(value, json!({ "Rejected": "OutputNotWhitelisted" }));
    assert_eq!(signer_calls(&s).await?, 0);
    Ok(())
}

#[tokio::test]
async fn hold_mode_queues_attacker_and_veto_returns_budget() -> anyhow::Result<()> {
    let s = setup(&SIGNING).await?;
    open(&s, 120_000_000_000, 600_000_000_000).await?;

    // A listed payee below queue_at is still signed at once.
    let listed = propose(&s, &payee_script(), PAYMENT).await?;
    assert!(listed.get("Signed").is_some(), "{listed}");

    // The same small amount to a stranger is held for the unlisted window.
    let outcome = call(
        &s.agent,
        &s,
        "propose_spend",
        bitcoin_proposal(1, 222, &stranger_script(), PAYMENT, FEE),
    )
    .await?;
    assert!(outcome
        .logs()
        .iter()
        .any(|log| log.contains("spend_queued")));
    let held: Value = outcome.into_result()?.json()?;
    let id = held["Queued"]["id"].as_str().unwrap().to_string();
    assert_eq!(signer_calls(&s).await?, 1);
    assert_eq!(view_u64(&s, "get_unlisted_spent_24h").await?, PAYMENT);

    let early: Value = call(&s.agent, &s, "execute", json!({ "id": id }))
        .await?
        .into_result()?
        .json()?;
    assert_eq!(early, json!({ "Rejected": "NotYetExecutable" }));

    call(&s.owner, &s, "veto", json!({ "id": id }))
        .await?
        .into_result()?;
    assert_eq!(view_u64(&s, "get_unlisted_spent_24h").await?, 0);
    assert_eq!(view_u64(&s, "get_spent_24h").await?, PAYMENT + FEE);
    assert_eq!(signer_calls(&s).await?, 1);
    Ok(())
}

#[tokio::test]
async fn held_unlisted_spend_signs_after_its_window() -> anyhow::Result<()> {
    let s = setup(&SIGNING).await?;
    open(&s, 0, 0).await?;
    let held = propose(&s, &stranger_script(), PAYMENT).await?;
    let id = held["Queued"]["id"].as_str().unwrap().to_string();
    let value: Value = call(&s.agent, &s, "execute", json!({ "id": id }))
        .await?
        .into_result()?
        .json()?;
    assert!(value.get("Signed").is_some(), "{value}");
    assert_eq!(signer_calls(&s).await?, 1);
    assert_eq!(view_u64(&s, "get_unlisted_spent_24h").await?, PAYMENT);
    Ok(())
}

#[tokio::test]
async fn unlisted_cap_holds_across_spends() -> anyhow::Result<()> {
    let s = setup(&SIGNING).await?;
    open(&s, 0, 0).await?;
    propose(&s, &stranger_script(), PAYMENT).await?;
    propose(&s, &stranger_script(), PAYMENT).await?;
    let third = propose(&s, &stranger_script(), PAYMENT).await?;
    assert_eq!(third, json!({ "Rejected": "UnlistedCapExceeded" }));
    assert_eq!(view_u64(&s, "get_unlisted_spent_24h").await?, 2 * PAYMENT);
    Ok(())
}

#[tokio::test]
async fn hold_mode_with_no_unlisted_cap_refuses_the_asset() -> anyhow::Result<()> {
    let s = setup(&SIGNING).await?;
    change_policy(&s, |policy| {
        policy["unlisted"] = json!("Hold");
        policy["unlisted_veto_delay_ns"] = policy["veto_delay_ns"].clone();
    })
    .await?;
    let value = propose(&s, &stranger_script(), PAYMENT).await?;
    assert_eq!(value, json!({ "Rejected": "UnlistedNotAllowed" }));
    Ok(())
}

#[tokio::test]
async fn set_policy_refuses_an_unlisted_window_shorter_than_the_listed_one() -> anyhow::Result<()> {
    let s = setup(&SIGNING).await?;
    let mut policy: Value = s.vault.view("get_policy").await?.json()?;
    policy["unlisted"] = json!("Hold");
    policy["unlisted_veto_delay_ns"] = json!(1);
    let failure = format!(
        "{:?}",
        call(&s.owner, &s, "set_policy", json!({ "policy": policy }))
            .await?
            .into_result()
    );
    assert!(failure.contains("unlisted_veto_delay_ns"), "{failure}");
    Ok(())
}

/// Upgrades a vault running the code from before open payees, with spends on its ledger. It needs
/// that build's wasm, so it runs only when `OLD_VAULT_WASM` names one; CI has none, so it skips.
#[tokio::test]
async fn migrate_v3_upgrades_a_deployed_vault() -> anyhow::Result<()> {
    let Ok(old_path) = std::env::var("OLD_VAULT_WASM") else {
        eprintln!("skipped: set OLD_VAULT_WASM to the vault wasm from before open payees");
        return Ok(());
    };
    let s = setup_with(&SIGNING, &std::fs::read(old_path)?).await?;
    let paid = propose(&s, &payee_script(), PAYMENT).await?;
    assert!(paid.get("Signed").is_some(), "{paid}");

    s.vault
        .as_account()
        .batch(s.vault.id())
        .deploy(&vault_wasm()?)
        .call(
            near_workspaces::operations::Function::new("migrate_v3")
                .args_json(json!({}))
                .gas(near_workspaces::types::Gas::from_tgas(100)),
        )
        .transact()
        .await?
        .into_result()?;

    let policy: Value = s.vault.view("get_policy").await?.json()?;
    assert_eq!(policy["unlisted"], "Refuse");
    assert_eq!(policy["caps"][0]["unlisted_per_24h"], "0");
    assert_eq!(view_u64(&s, "get_spent_24h").await?, PAYMENT + FEE);
    assert_eq!(
        propose(&s, &stranger_script(), PAYMENT).await?,
        json!({ "Rejected": "OutputNotWhitelisted" })
    );

    open(&s, 0, 0).await?;
    let held = propose(&s, &stranger_script(), PAYMENT).await?;
    // A refusal takes no id, so this is the second spend.
    assert_eq!(held["Queued"]["id"], "1");
    Ok(())
}

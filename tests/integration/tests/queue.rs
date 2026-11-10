//! The veto queue, `execute` and freeze, end to end against the mock signer.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::Account;
use serde_json::{json, Value};

const PAYMENT: u64 = 50_000;
const FEE: u64 = 10_000;
const CHARGE: u64 = PAYMENT + FEE;
/// Every honest spend here reaches this, so it queues.
const QUEUEING: BtcCap = BtcCap {
    per_tx: 100_000,
    per_24h: 500_000,
    queue_at: CHARGE,
};

fn large_spend() -> Value {
    bitcoin_proposal(1, 222, &payee_script(), PAYMENT, FEE)
}

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

async fn propose(s: &Setup) -> anyhow::Result<Value> {
    Ok(call(&s.agent, s, "propose_spend", large_spend())
        .await?
        .into_result()?
        .json()?)
}

async fn execute(s: &Setup, id: &str) -> anyhow::Result<ExecutionFinalResult> {
    call(&s.agent, s, "execute", json!({ "id": id })).await
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

async fn signer_calls(s: &Setup) -> anyhow::Result<u64> {
    Ok(s.signer.view("get_calls").await?.json()?)
}

async fn queue_len(s: &Setup) -> anyhow::Result<usize> {
    Ok(s.vault.view("get_queue").await?.json::<Vec<Value>>()?.len())
}

/// Replaces the policy, keeping everything `setup` chose but what `change` edits.
async fn change_policy(s: &Setup, change: impl FnOnce(&mut Value)) -> anyhow::Result<()> {
    let mut policy: Value = s.vault.view("get_policy").await?.json()?;
    change(&mut policy);
    call(&s.owner, s, "set_policy", json!({ "policy": policy }))
        .await?
        .into_result()?;
    Ok(())
}

async fn no_delay(s: &Setup) -> anyhow::Result<()> {
    change_policy(s, |policy| policy["veto_delay_ns"] = json!(0)).await
}

#[tokio::test]
async fn large_spend_is_queued_and_charged_but_not_signed() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    let outcome = call(&s.agent, &s, "propose_spend", large_spend()).await?;
    assert!(outcome
        .logs()
        .iter()
        .any(|log| log.contains("spend_queued")));
    let value: Value = outcome.into_result()?.json()?;
    assert_eq!(value["Queued"]["id"], "0");
    assert_eq!(signer_calls(&s).await?, 0);
    assert_eq!(spent(&s).await?, CHARGE);
    let queue: Vec<Value> = s.vault.view("get_queue").await?.json()?;
    assert_eq!(queue[0]["id"], "0");
    assert_eq!(queue[0]["executable_at"], value["Queued"]["executable_at"]);
    Ok(())
}

#[tokio::test]
async fn queued_spend_not_executable_before_delay() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    propose(&s).await?;
    let outcome = execute(&s, "0").await?;
    assert!(outcome
        .logs()
        .iter()
        .any(|log| log.contains("NotYetExecutable")));
    let value: Value = outcome.into_result()?.json()?;
    assert_eq!(value, json!({ "Rejected": "NotYetExecutable" }));
    assert_eq!(signer_calls(&s).await?, 0);
    assert_eq!(queue_len(&s).await?, 1);
    assert_eq!(spent(&s).await?, CHARGE);
    Ok(())
}

#[tokio::test]
async fn raised_delay_applies_to_spends_already_queued() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    no_delay(&s).await?;
    propose(&s).await?;
    change_policy(&s, |policy| {
        policy["veto_delay_ns"] = json!(86_400_000_000_000u64)
    })
    .await?;
    let value: Value = execute(&s, "0").await?.into_result()?.json()?;
    assert_eq!(value, json!({ "Rejected": "NotYetExecutable" }));
    assert_eq!(signer_calls(&s).await?, 0);
    Ok(())
}

#[tokio::test]
async fn execute_signs_after_the_delay_with_the_hash_it_stored() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    no_delay(&s).await?;
    propose(&s).await?;
    let value: Value = execute(&s, "0").await?.into_result()?.json()?;
    assert_eq!(value["Signed"]["id"], "0");
    assert_eq!(value["Signed"]["signatures"].as_array().unwrap().len(), 1);
    assert_eq!(signer_calls(&s).await?, 1);
    assert_eq!(queue_len(&s).await?, 0);
    assert_eq!(spent(&s).await?, CHARGE);
    Ok(())
}

#[tokio::test]
async fn queued_spend_cannot_execute_twice() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    no_delay(&s).await?;
    propose(&s).await?;
    execute(&s, "0").await?.into_result()?;
    let failure = format!("{:?}", execute(&s, "0").await?.into_result());
    assert!(failure.contains("UnknownSpend"), "{failure}");
    assert_eq!(signer_calls(&s).await?, 1);
    Ok(())
}

#[tokio::test]
async fn vetoed_spend_cannot_execute() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    no_delay(&s).await?;
    for (id, who) in [("0", &s.owner), ("1", &s.guardian)] {
        propose(&s).await?;
        let outcome = call(who, &s, "veto", json!({ "id": id })).await?;
        assert!(outcome
            .logs()
            .iter()
            .any(|log| log.contains("spend_vetoed")));
        outcome.into_result()?;
        assert_eq!(spent(&s).await?, 0);
        let failure = format!("{:?}", execute(&s, id).await?.into_result());
        assert!(failure.contains("UnknownSpend"), "{failure}");
    }
    assert_eq!(signer_calls(&s).await?, 0);
    assert_eq!(queue_len(&s).await?, 0);
    Ok(())
}

#[tokio::test]
async fn veto_of_an_unknown_spend_fails() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    let failure = format!(
        "{:?}",
        call(&s.owner, &s, "veto", json!({ "id": "7" }))
            .await?
            .into_result()
    );
    assert!(failure.contains("UnknownSpend"), "{failure}");
    Ok(())
}

#[tokio::test]
async fn execute_rechecks_tightened_policy() -> anyhow::Result<()> {
    type Tighten = fn(&mut Value);
    let tightenings: [(&str, Tighten); 4] = [
        ("OutputNotWhitelisted", |p| p["payees"] = json!([])),
        ("PerTxCapExceeded", |p| {
            p["caps"][0]["per_tx"] = json!("59999");
            p["caps"][0]["queue_at"] = json!("59999");
        }),
        ("DailyCapExceeded", |p| {
            p["caps"][0]["per_24h"] = json!("59999")
        }),
        ("FeeTooHigh", |p| p["btc_max_fee_rate"] = json!(1)),
    ];
    for (error, tighten) in tightenings {
        let s = setup(&QUEUEING).await?;
        no_delay(&s).await?;
        propose(&s).await?;
        change_policy(&s, tighten).await?;
        let value: Value = execute(&s, "0").await?.into_result()?.json()?;
        assert_eq!(value, json!({ "Rejected": error }));
        assert_eq!(signer_calls(&s).await?, 0, "{error}");
        assert_eq!(queue_len(&s).await?, 0, "{error}");
        assert_eq!(spent(&s).await?, 0, "{error}");
    }
    Ok(())
}

#[tokio::test]
async fn queue_full_rejects() -> anyhow::Result<()> {
    let cap = BtcCap {
        per_24h: 100_000_000,
        ..QUEUEING
    };
    let s = setup(&cap).await?;
    for _ in 0..16 {
        assert!(propose(&s).await?.get("Queued").is_some());
    }
    assert_eq!(propose(&s).await?, json!({ "Rejected": "QueueFull" }));
    assert_eq!(queue_len(&s).await?, 16);
    assert_eq!(spent(&s).await?, 16 * CHARGE);

    // Below the threshold still signs, so a full queue doesn't stop small payments.
    let small = bitcoin_proposal(1, 222, &payee_script(), 10_000, 1_000);
    let value: Value = call(&s.agent, &s, "propose_spend", small)
        .await?
        .into_result()?
        .json()?;
    assert!(value.get("Signed").is_some(), "{value}");

    call(&s.guardian, &s, "veto", json!({ "id": "3" }))
        .await?
        .into_result()?;
    assert!(propose(&s).await?.get("Queued").is_some());
    Ok(())
}

#[tokio::test]
async fn frozen_blocks_propose_and_execute() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    no_delay(&s).await?;
    propose(&s).await?;
    call(&s.guardian, &s, "freeze", json!({}))
        .await?
        .into_result()?;

    let refused = format!(
        "{:?}",
        call(&s.agent, &s, "propose_spend", large_spend())
            .await?
            .into_result()
    );
    assert!(refused.contains("Frozen"), "{refused}");
    let refused = format!("{:?}", execute(&s, "0").await?.into_result());
    assert!(refused.contains("Frozen"), "{refused}");
    assert_eq!(signer_calls(&s).await?, 0);
    assert_eq!(queue_len(&s).await?, 1);

    call(&s.owner, &s, "unfreeze", json!({}))
        .await?
        .into_result()?;
    let value: Value = execute(&s, "0").await?.into_result()?.json()?;
    assert!(value.get("Signed").is_some(), "{value}");
    Ok(())
}

#[tokio::test]
async fn veto_still_works_during_a_freeze() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    propose(&s).await?;
    call(&s.owner, &s, "freeze", json!({}))
        .await?
        .into_result()?;
    call(&s.guardian, &s, "veto", json!({ "id": "0" }))
        .await?
        .into_result()?;
    assert_eq!(queue_len(&s).await?, 0);
    assert_eq!(spent(&s).await?, 0);
    Ok(())
}

#[tokio::test]
async fn sign_failure_after_execute_releases_the_new_reservation() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    no_delay(&s).await?;
    propose(&s).await?;
    s.signer
        .call("set_fail_after")
        .args_json(json!({ "calls": 0 }))
        .transact()
        .await?
        .into_result()?;
    let value: Value = execute(&s, "0").await?.into_result()?.json()?;
    assert_eq!(value, json!({ "Rejected": "SignFailed" }));
    assert_eq!(queue_len(&s).await?, 0);
    assert_eq!(spent(&s).await?, 0);
    Ok(())
}

#[tokio::test]
async fn only_the_owner_can_replace_the_guardian() -> anyhow::Result<()> {
    let s = setup(&QUEUEING).await?;
    for who in [&s.guardian, &s.agent] {
        let failure = format!(
            "{:?}",
            call(who, &s, "set_guardian", json!({ "guardian": who.id() }))
                .await?
                .into_result()
        );
        assert!(failure.contains("NotOwner"), "{failure}");
    }
    let old = s.guardian.clone();
    let fresh = s.worker.dev_create_account().await?;
    call(
        &s.owner,
        &s,
        "set_guardian",
        json!({ "guardian": fresh.id() }),
    )
    .await?
    .into_result()?;
    let roles: Value = s.vault.view("get_roles").await?.json()?;
    assert_eq!(roles["guardian"], fresh.id().to_string());
    let failure = format!(
        "{:?}",
        call(&old, &s, "freeze", json!({})).await?.into_result()
    );
    assert!(failure.contains("NotGuardianOrOwner"), "{failure}");
    Ok(())
}

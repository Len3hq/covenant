//! Replacing the agent: only the owner can, the agent can't be the owner or guardian, and the old
//! agent loses its access at once.

mod common;

use common::*;
use near_workspaces::Account;
use serde_json::{json, Value};

const SIGNING: BtcCap = BtcCap {
    per_tx: 100_000,
    per_24h: 500_000,
    queue_at: 100_000,
};

async fn set_agent(who: &Account, s: &Setup, agent: &str) -> anyhow::Result<String> {
    let result = who
        .call(s.vault.id(), "set_agent")
        .args_json(json!({ "agent": agent }))
        .transact()
        .await?;
    Ok(match result.into_result() {
        Ok(outcome) => {
            assert!(outcome
                .logs()
                .iter()
                .any(|log| log.contains("agent_updated")));
            "ok".into()
        }
        Err(failure) => format!("{failure:?}"),
    })
}

async fn propose(who: &Account, s: &Setup) -> anyhow::Result<Result<Value, String>> {
    let result = who
        .call(s.vault.id(), "propose_spend")
        .args_json(bitcoin_proposal(1, 222, &payee_script(), 20_000, 1_000))
        .max_gas()
        .transact()
        .await?;
    Ok(match result.into_result() {
        Ok(outcome) => Ok(outcome.json()?),
        Err(failure) => Err(format!("{failure:?}")),
    })
}

#[tokio::test]
async fn only_the_owner_can_replace_the_agent() -> anyhow::Result<()> {
    let s = setup(&SIGNING).await?;
    let fresh = s.worker.dev_create_account().await?;
    for who in [&s.agent, &s.guardian] {
        let failure = set_agent(who, &s, fresh.id().as_str()).await?;
        assert!(failure.contains("NotOwner"), "{failure}");
    }
    for taken in [s.owner.id(), s.guardian.id()] {
        let failure = set_agent(&s.owner, &s, taken.as_str()).await?;
        assert!(failure.contains("can't also be"), "{failure}");
    }
    let failure = s
        .owner
        .call(s.vault.id(), "set_guardian")
        .args_json(json!({ "guardian": s.agent.id() }))
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| format!("{failure:?}"))
        .unwrap_err();
    assert!(failure.contains("can't also be the guardian"), "{failure}");
    Ok(())
}

#[tokio::test]
async fn old_agent_rejected_after_set_agent() -> anyhow::Result<()> {
    let s = setup(&SIGNING).await?;
    let fresh = s.worker.dev_create_account().await?;
    assert!(propose(&s.agent, &s).await?.is_ok());
    assert_eq!(set_agent(&s.owner, &s, fresh.id().as_str()).await?, "ok");
    let roles: Value = s.vault.view("get_roles").await?.json()?;
    assert_eq!(roles["agent"], fresh.id().as_str());
    let refused = propose(&s.agent, &s).await?.unwrap_err();
    assert!(refused.contains("NotAgent"), "{refused}");
    let value = propose(&fresh, &s).await?.unwrap();
    assert!(value.get("Signed").is_some(), "{value}");
    Ok(())
}

use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use std::path::Path;

const WASM: &str = "../../target/near/covenant_vault/covenant_vault.wasm";

struct Vault {
    contract: Contract,
    owner: Account,
    guardian: Account,
    agent: Account,
    stranger: Account,
}

async fn vault() -> anyhow::Result<Vault> {
    let wasm = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(WASM))
        .map_err(|e| anyhow::anyhow!("{WASM}: {e}. Run `make wasm` first."))?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let root = worker.root_account()?;
    let mut accounts = Vec::new();
    for name in ["owner", "guardian", "agent", "stranger"] {
        accounts.push(
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(5))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let stranger = accounts.pop().unwrap();
    let agent = accounts.pop().unwrap();
    let guardian = accounts.pop().unwrap();
    let owner = accounts.pop().unwrap();

    contract
        .call("new")
        .args_json(init_args(&owner, &guardian, &agent))
        .transact()
        .await?
        .into_result()?;
    Ok(Vault {
        contract,
        owner,
        guardian,
        agent,
        stranger,
    })
}

fn policy(btc_max_fee_rate: u64) -> Value {
    json!({
        "caps": [{ "asset": "Btc", "per_tx": "100000", "per_24h": "500000", "queue_at": "50000" }],
        "payees": [],
        "btc_max_fee_rate": btc_max_fee_rate,
        "btc_max_inputs": 3,
        "evm_chain_ids": [84532],
        "evm_max_gas_cost": "1000000000000000",
        "veto_delay_ns": 120000000000u64
    })
}

fn init_args(owner: &Account, guardian: &Account, agent: &Account) -> Value {
    let mut btc_pubkey = vec![0x02u8];
    btc_pubkey.extend([7u8; 32]);
    json!({
        "owner": owner.id(),
        "guardian": guardian.id(),
        "agent": agent.id(),
        "signer": "v1.signer-prod.testnet",
        "paths": { "btc": "btc-vault-1", "evm": "evm-vault-1", "sol": "sol-vault-1" },
        "btc_pubkey": STANDARD.encode(btc_pubkey),
        "evm_address": vec![9u8; 20],
        "policy": policy(50)
    })
}

/// Calls a method and asserts it fails with the named `CovenantError`.
async fn assert_refused(
    caller: &Account,
    vault: &Contract,
    method: &str,
    args: Value,
    error: &str,
) -> anyhow::Result<()> {
    let outcome = caller
        .call(vault.id(), method)
        .args_json(args)
        .max_gas()
        .transact()
        .await?;
    let failure = format!("{:?}", outcome.into_result().unwrap_err());
    assert!(
        failure.contains(error),
        "{} calling {method}: expected {error}, got {failure}",
        caller.id()
    );
    Ok(())
}

fn proposal() -> Value {
    json!({ "chain": "Evm", "tx": "", "meta": "Evm" })
}

#[tokio::test]
async fn non_agent_cannot_propose() -> anyhow::Result<()> {
    let v = vault().await?;
    for caller in [&v.owner, &v.guardian, &v.stranger] {
        assert_refused(caller, &v.contract, "propose_spend", proposal(), "NotAgent").await?;
    }
    // The agent gets past the access check, and only then do the empty bytes fail.
    assert_refused(
        &v.agent,
        &v.contract,
        "propose_spend",
        proposal(),
        "MalformedTx",
    )
    .await
}

#[tokio::test]
async fn non_agent_cannot_execute() -> anyhow::Result<()> {
    let v = vault().await?;
    for caller in [&v.owner, &v.guardian, &v.stranger] {
        assert_refused(
            caller,
            &v.contract,
            "execute",
            json!({ "id": "0" }),
            "NotAgent",
        )
        .await?;
    }
    Ok(())
}

#[tokio::test]
async fn only_owner_can_set_policy() -> anyhow::Result<()> {
    let v = vault().await?;
    let args = json!({ "policy": policy(7) });
    for caller in [&v.guardian, &v.agent, &v.stranger] {
        assert_refused(caller, &v.contract, "set_policy", args.clone(), "NotOwner").await?;
    }
    let fee_rate = |policy: Value| policy["btc_max_fee_rate"].as_u64();
    let current: Value = v.contract.view("get_policy").await?.json()?;
    assert_eq!(fee_rate(current), Some(50));

    v.owner
        .call(v.contract.id(), "set_policy")
        .args_json(args)
        .transact()
        .await?
        .into_result()?;
    let updated: Value = v.contract.view("get_policy").await?.json()?;
    assert_eq!(fee_rate(updated), Some(7));
    Ok(())
}

#[tokio::test]
async fn guardian_can_freeze_not_unfreeze() -> anyhow::Result<()> {
    let v = vault().await?;
    v.guardian
        .call(v.contract.id(), "freeze")
        .transact()
        .await?
        .into_result()?;
    assert!(v.contract.view("is_frozen").await?.json::<bool>()?);

    for caller in [&v.guardian, &v.agent, &v.stranger] {
        assert_refused(caller, &v.contract, "unfreeze", json!({}), "NotOwner").await?;
    }
    assert!(v.contract.view("is_frozen").await?.json::<bool>()?);

    v.owner
        .call(v.contract.id(), "unfreeze")
        .transact()
        .await?
        .into_result()?;
    assert!(!v.contract.view("is_frozen").await?.json::<bool>()?);
    Ok(())
}

#[tokio::test]
async fn agent_and_strangers_cannot_freeze_or_veto() -> anyhow::Result<()> {
    let v = vault().await?;
    for caller in [&v.agent, &v.stranger] {
        assert_refused(
            caller,
            &v.contract,
            "freeze",
            json!({}),
            "NotGuardianOrOwner",
        )
        .await?;
        assert_refused(
            caller,
            &v.contract,
            "veto",
            json!({ "id": "0" }),
            "NotGuardianOrOwner",
        )
        .await?;
    }
    assert!(!v.contract.view("is_frozen").await?.json::<bool>()?);
    Ok(())
}

#[tokio::test]
async fn vault_cannot_be_initialized_twice() -> anyhow::Result<()> {
    let v = vault().await?;
    let attempt = v
        .stranger
        .call(v.contract.id(), "new")
        .args_json(init_args(&v.stranger, &v.stranger, &v.stranger))
        .transact()
        .await?;
    assert!(attempt.into_result().is_err());
    let policy: Value = v.contract.view("get_policy").await?.json()?;
    assert_eq!(policy["btc_max_fee_rate"], 50);
    Ok(())
}

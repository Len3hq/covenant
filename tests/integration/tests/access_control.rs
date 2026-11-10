use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::path::Path;

/// What the live agent prepays. The 1 NEAR allowance must cover this at a pessimistic gas price.
const AGENT_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(300);
const WASM: &str = "../../target/near/covenant_vault/covenant_vault.wasm";

struct Vault {
    worker: Worker<Sandbox>,
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
        worker,
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
        "sol_pubkey": vec![5u8; 32],
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
        .gas(AGENT_GAS)
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

/// The same key the live agent holds: its account signs, but the chain limits what it can sign.
#[tokio::test]
async fn agent_key_cannot_call_set_policy() -> anyhow::Result<()> {
    let v = vault().await?;
    let secret = SecretKey::from_random(KeyType::ED25519);
    let access = AccessKey::function_call_access(
        v.contract.id(),
        &["propose_spend", "execute"],
        Some(NearToken::from_near(1)),
    );
    v.agent
        .batch(v.agent.id())
        .add_key(secret.public_key(), access)
        .transact()
        .await?
        .into_result()?;
    let restricted = Account::from_secret_key(v.agent.id().clone(), secret, &v.worker);

    let owner_args: [(&str, Value); 6] = [
        ("set_policy", json!({ "policy": policy(1) })),
        ("set_guardian", json!({ "guardian": restricted.id() })),
        ("freeze", json!({})),
        ("unfreeze", json!({})),
        ("veto", json!({ "id": "0" })),
        ("on_signed", json!({})),
    ];
    let before: Value = v.contract.view("get_policy").await?.json()?;
    for (method, args) in owner_args {
        let outcome = restricted
            .call(v.contract.id(), method)
            .args_json(args)
            .gas(AGENT_GAS)
            .transact()
            .await;
        let failure = format!("{outcome:?}");
        assert!(
            failure.contains("MethodNameMismatch"),
            "{method}: {failure}"
        );
    }
    assert_eq!(
        v.contract.view("get_policy").await?.json::<Value>()?,
        before
    );

    // It can't touch the vault's money or reach any other contract.
    let moved = restricted
        .transfer_near(v.stranger.id(), NearToken::from_yoctonear(1))
        .await;
    assert!(
        format!("{moved:?}").contains("RequiresFullAccess"),
        "{moved:?}"
    );
    let paid = restricted
        .call(v.contract.id(), "propose_spend")
        .args_json(proposal())
        .deposit(NearToken::from_yoctonear(1))
        .gas(AGENT_GAS)
        .transact()
        .await;
    assert!(
        format!("{paid:?}").contains("DepositWithFunctionCall"),
        "{paid:?}"
    );
    let elsewhere = restricted
        .call(v.stranger.id(), "propose_spend")
        .args_json(proposal())
        .gas(AGENT_GAS)
        .transact()
        .await;
    assert!(
        format!("{elsewhere:?}").contains("ReceiverMismatch"),
        "{elsewhere:?}"
    );

    // What it is allowed to call reaches the contract, which then applies its own checks.
    assert_refused(
        &restricted,
        &v.contract,
        "propose_spend",
        proposal(),
        "MalformedTx",
    )
    .await?;
    assert_refused(
        &restricted,
        &v.contract,
        "execute",
        json!({ "id": "0" }),
        "UnknownSpend",
    )
    .await
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

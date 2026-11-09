//! The factory against the real vault code and the mock signer.

mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::{evm_proposal, policy, wasm, ROOMY};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{CryptoHash, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const VAULT_WASM: &str = "../../target/near/covenant_vault/covenant_vault.wasm";
const FACTORY_WASM: &str = "../../target/near/covenant_factory/covenant_factory.wasm";
const SIGNER_WASM: &str = "../../target/near/covenant_mock_signer/covenant_mock_signer.wasm";

struct Setup {
    worker: Worker<Sandbox>,
    factory: Contract,
    signer: Contract,
    owner: Account,
    agent: Account,
    code_hash: CryptoHash,
}

async fn setup() -> anyhow::Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let signer = worker.dev_deploy(&wasm(SIGNER_WASM)?).await?;
    let code = wasm(VAULT_WASM)?;
    signer
        .call("publish_global")
        .args_json(json!({ "code": STANDARD.encode(&code) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let code_hash = CryptoHash(Sha256::digest(&code).into());
    let root = worker.root_account()?;
    let account = root
        .create_subaccount("vaults")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let factory = account.deploy(&wasm(FACTORY_WASM)?).await?.into_result()?;
    factory
        .call("new")
        .args_json(json!({ "signer": signer.id(), "vault_code_hash": code_hash.to_string() }))
        .transact()
        .await?
        .into_result()?;
    let owner = root
        .create_subaccount("owner")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let agent = root
        .create_subaccount("agent")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    Ok(Setup {
        worker,
        factory,
        signer,
        owner,
        agent,
        code_hash,
    })
}

impl Setup {
    /// The vault's account name, and what `create_vault` returned once everything settled.
    async fn create(&self, name: &str, near: u128) -> anyhow::Result<Value> {
        let outcome = self
            .owner
            .call(self.factory.id(), "create_vault")
            .args_json(json!({
                "name": name,
                "agent": self.agent.id(),
                "guardian": null,
                "policy": policy(&ROOMY),
            }))
            .deposit(NearToken::from_near(near))
            .max_gas()
            .transact()
            .await?;
        Ok(outcome.into_result()?.json()?)
    }

    fn vault_id(&self, name: &str) -> near_workspaces::AccountId {
        format!("{name}.{}", self.factory.id()).parse().unwrap()
    }

    /// The owner's balance once gas refunds from earlier transactions have landed.
    async fn balance(&self) -> anyhow::Result<u128> {
        self.worker.fast_forward(3).await?;
        Ok(self.owner.view_account().await?.balance.as_yoctonear())
    }

    async fn factory_balance(&self) -> anyhow::Result<u128> {
        Ok(self.factory.view_account().await?.balance.as_yoctonear())
    }

    /// What a failed creation of `near` NEAR cost the owner, with the factory no poorer for it.
    async fn cost_of_failure(&self, name: &str, near: u128) -> anyhow::Result<u128> {
        let before = self.balance().await?;
        let factory_before = self.factory_balance().await?;
        assert_eq!(self.create(name, near).await?, json!(false));
        let after = self.balance().await?;
        assert!(self.factory_balance().await? >= factory_before);
        assert!(after <= before, "the owner gained {} yocto", after - before);
        Ok(before - after)
    }
}

#[tokio::test]
async fn factory_creates_a_working_vault_owned_by_the_caller() -> anyhow::Result<()> {
    let s = setup().await?;
    assert_eq!(s.create("acme", 2).await?, json!(true));
    let vault = s.vault_id("acme");

    let roles: Value = s.worker.view(&vault, "get_roles").await?.json()?;
    assert_eq!(roles["owner"], json!(s.owner.id()));
    assert_eq!(roles["agent"], json!(s.agent.id()));

    let outcome: Value = s
        .agent
        .call(&vault, "propose_spend")
        .args_json(evm_proposal())
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(outcome.get("Signed").is_some(), "{outcome}");

    let listed: Vec<String> = s
        .factory
        .view("vaults_of")
        .args_json(json!({ "owner": s.owner.id() }))
        .await?
        .json()?;
    assert_eq!(listed, [vault.to_string()]);
    Ok(())
}

#[tokio::test]
async fn factory_vault_has_no_keys_and_runs_the_shared_code() -> anyhow::Result<()> {
    let s = setup().await?;
    s.create("acme", 2).await?;
    let vault = s.vault_id("acme");
    let details = s.worker.view_account(&vault).await?;
    // near-workspaces doesn't export the type, so compare how it prints.
    assert_eq!(
        format!("{:?}", details.contract_state),
        format!("GlobalHash({:?})", s.code_hash),
    );
    assert!(s.worker.view_access_keys(&vault).await?.is_empty());
    let published: String = s.factory.view("get_vault_code_hash").await?.json()?;
    assert_eq!(published, s.code_hash.to_string());
    Ok(())
}

#[tokio::test]
async fn factory_gives_each_vault_its_own_addresses_from_the_signer() -> anyhow::Result<()> {
    let s = setup().await?;
    s.create("one", 2).await?;
    s.create("two", 2).await?;
    let one: Value = s
        .worker
        .view(&s.vault_id("one"), "get_addresses")
        .await?
        .json()?;
    let two: Value = s
        .worker
        .view(&s.vault_id("two"), "get_addresses")
        .await?
        .json()?;
    assert_ne!(one["btc_pubkey"], two["btc_pubkey"]);
    assert_ne!(one["evm_address"], two["evm_address"]);
    Ok(())
}

#[tokio::test]
async fn factory_refunds_when_the_name_is_taken() -> anyhow::Result<()> {
    let s = setup().await?;
    s.create("acme", 2).await?;
    let lost = s.cost_of_failure("acme", 3).await?;
    assert!(
        lost < NearToken::from_millinear(100).as_yoctonear(),
        "lost {lost} yocto"
    );
    let listed: Vec<String> = s
        .factory
        .view("vaults_of")
        .args_json(json!({ "owner": s.owner.id() }))
        .await?
        .json()?;
    assert_eq!(listed.len(), 1);
    Ok(())
}

#[tokio::test]
async fn factory_refunds_when_the_signer_fails() -> anyhow::Result<()> {
    let s = setup().await?;
    s.signer
        .call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let lost = s.cost_of_failure("acme", 3).await?;
    assert!(
        lost < NearToken::from_millinear(100).as_yoctonear(),
        "lost {lost} yocto"
    );
    assert!(s.worker.view_account(&s.vault_id("acme")).await.is_err());
    Ok(())
}

#[tokio::test]
async fn factory_callbacks_refuse_outside_callers() -> anyhow::Result<()> {
    let s = setup().await?;
    let outcome = s
        .owner
        .call(s.factory.id(), "on_created")
        .args_json(json!({
            "vault": s.vault_id("fake"),
            "owner": s.owner.id(),
            "agent": s.agent.id(),
            "deposit": "1",
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(outcome.is_failure());
    Ok(())
}

#[tokio::test]
async fn factory_costs_a_vault_little_because_the_code_is_shared() -> anyhow::Result<()> {
    let s = setup().await?;
    s.create("acme", 2).await?;
    let details = s.worker.view_account(&s.vault_id("acme")).await?;
    println!("vault storage: {} bytes", details.storage_usage);
    assert!(
        details.storage_usage < 10_000,
        "{} bytes",
        details.storage_usage
    );
    Ok(())
}

use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::types::NearToken;
use serde_json::json;
use std::path::Path;

const WASM: &str = "../../target/near/covenant_vault/covenant_vault.wasm";

#[tokio::test]
async fn vault_deploys_and_answers_views() -> anyhow::Result<()> {
    let wasm = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(WASM))
        .map_err(|e| anyhow::anyhow!("{WASM}: {e}. Run `make wasm` first."))?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let root = worker.root_account()?;
    let owner = root
        .create_subaccount("owner")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    let agent = root
        .create_subaccount("agent")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;

    let mut btc_pubkey = vec![0x02u8];
    btc_pubkey.extend([7u8; 32]);
    contract
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "guardian": null,
            "agent": agent.id(),
            "signer": "v1.signer-prod.testnet",
            "paths": { "btc": "btc-vault-1", "evm": "evm-vault-1", "sol": "sol-vault-1" },
            "btc_pubkey": STANDARD.encode(btc_pubkey),
            "evm_address": vec![9u8; 20],
            "sol_pubkey": vec![5u8; 32],
            "policy": {
                "caps": [{ "asset": "Btc", "per_tx": "100000", "per_24h": "500000", "queue_at": "50000" }],
                "payees": [],
                "btc_max_fee_rate": 50,
                "btc_max_inputs": 3,
                "evm_chain_ids": [84532],
                "evm_max_gas_cost": "1000000000000000",
                "veto_delay_ns": 120000000000u64
            }
        }))
        .transact()
        .await?
        .into_result()?;

    assert!(!contract.view("is_frozen").await?.json::<bool>()?);

    let refused = agent
        .call(contract.id(), "set_policy")
        .args_json(
            json!({ "policy": contract.view("get_policy").await?.json::<serde_json::Value>()? }),
        )
        .transact()
        .await?;
    assert!(format!("{:?}", refused.into_result().unwrap_err()).contains("NotOwner"));

    owner
        .call(contract.id(), "freeze")
        .transact()
        .await?
        .into_result()?;
    assert!(contract.view("is_frozen").await?.json::<bool>()?);
    Ok(())
}

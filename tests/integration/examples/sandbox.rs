//! Starts a local NEAR sandbox with the real vault and the mock signer, for the keyless demo.
//! Prints one JSON line with the accounts and keys once it's ready, then runs until stdin closes.
//! Everything here is local and thrown away: no key it prints controls anything real.

use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;

const VAULT_WASM: &str = "../../target/near/covenant_vault/covenant_vault.wasm";
const SIGNER_WASM: &str = "../../target/near/covenant_mock_signer/covenant_mock_signer.wasm";
const POLICY: &str = "../../scripts/policy.testnet.json";
/// The public key for secret key 1, so the demo's Bitcoin and EVM addresses are valid ones.
const BTC_PUBKEY: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const EVM_ADDRESS: &str = "7e5f4552091a69125d5dfcb7b8c2659029395bdf";

fn read(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .map_err(|e| anyhow::anyhow!("{path}: {e}. Run `make wasm` first."))
}

fn decode_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let signer = worker.dev_deploy(&read(SIGNER_WASM)?).await?;
    let vault = worker.dev_deploy(&read(VAULT_WASM)?).await?;
    let root = worker.root_account()?;
    root.transfer_near(vault.id(), NearToken::from_near(10))
        .await?
        .into_result()?;
    let mut accounts = Vec::new();
    for name in ["owner", "guardian", "agent"] {
        accounts.push(
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(10))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let [owner, guardian, agent] = <[_; 3]>::try_from(accounts).unwrap();
    let policy: Value = serde_json::from_slice(&read(POLICY)?)?;
    vault
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "guardian": guardian.id(),
            "agent": agent.id(),
            "signer": signer.id(),
            "paths": { "btc": "btc-vault-1", "evm": "evm-vault-1", "sol": "sol-vault-1" },
            "btc_pubkey": STANDARD.encode(decode_hex(BTC_PUBKEY)),
            "evm_address": decode_hex(EVM_ADDRESS),
            "policy": policy,
        }))
        .transact()
        .await?
        .into_result()?;

    let ready = json!({
        "ready": true,
        "rpcUrl": worker.rpc_addr(),
        "vault": vault.id(),
        "agent": { "id": agent.id(), "key": agent.secret_key().to_string() },
        "owner": { "id": owner.id(), "key": owner.secret_key().to_string() },
    });
    println!("{ready}");
    // The sandbox lives as long as this process; the demo closes stdin when it's done.
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    Ok(())
}

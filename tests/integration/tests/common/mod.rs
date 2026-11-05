//! A vault wired to the mock signer, and spends for it to sign.
#![allow(dead_code)]

use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use ripemd::Ripemd160;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

const VAULT_WASM: &str = "../../target/near/covenant_vault/covenant_vault.wasm";
const SIGNER_WASM: &str = "../../target/near/covenant_mock_signer/covenant_mock_signer.wasm";
pub const PUBKEY: [u8; 33] = [0x02; 33];
pub const COIN: u64 = 100_000;

pub struct Setup {
    pub worker: Worker<Sandbox>,
    pub vault: Contract,
    pub signer: Contract,
    pub owner: Account,
    pub guardian: Account,
    pub agent: Account,
}

pub struct BtcCap {
    pub per_tx: u64,
    pub per_24h: u64,
    pub queue_at: u64,
}

pub const ROOMY: BtcCap = BtcCap {
    per_tx: 500_000,
    per_24h: 1_000_000_000,
    queue_at: 250_000,
};

/// The USDC transfer vector from viem.
pub fn evm_vector() -> Value {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../vectors/evm_hash.json")).unwrap();
    vectors["vectors"][1].clone()
}

pub fn decode_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

pub fn wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .map_err(|e| anyhow::anyhow!("{path}: {e}. Run `make wasm` first."))
}

pub fn double_sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(bytes)).into()
}

pub fn own_script() -> Vec<u8> {
    let hash = Ripemd160::digest(Sha256::digest(PUBKEY));
    [vec![0x00, 0x14], hash.to_vec()].concat()
}

pub fn payee_script() -> Vec<u8> {
    [vec![0x00, 0x14], vec![0xaa; 20]].concat()
}

pub fn stranger_script() -> Vec<u8> {
    [vec![0x00, 0x14], vec![0xbb; 20]].concat()
}

pub fn output(amount: u64, script: &[u8]) -> Vec<u8> {
    let mut bytes = amount.to_le_bytes().to_vec();
    if script.len() < 0xfd {
        bytes.push(script.len() as u8);
    } else {
        bytes.push(0xfd);
        bytes.extend((script.len() as u16).to_le_bytes());
    }
    bytes.extend(script);
    bytes
}

/// A previous transaction of about `size` bytes paying the vault one coin at output 0.
pub fn prev_tx(salt: u8, size: usize) -> Vec<u8> {
    let mut tx = vec![2, 0, 0, 0, 1];
    tx.extend([salt; 32]);
    tx.extend([0; 4]);
    tx.push(0);
    tx.extend([0xff; 4]);
    tx.push(2);
    tx.extend(output(COIN, &own_script()));
    let padding = size.saturating_sub(tx.len() + 16).max(1);
    tx.extend(output(1_000, &vec![0x51; padding]));
    tx.extend([0; 4]);
    tx
}

/// Arguments for `propose_spend`: `inputs` coins paying `amount` to `to`, with the rest but `fee`
/// going back to the vault.
pub fn bitcoin_proposal(inputs: u8, prev_size: usize, to: &[u8], amount: u64, fee: u64) -> Value {
    let prevs: Vec<Vec<u8>> = (1..=inputs).map(|salt| prev_tx(salt, prev_size)).collect();
    let mut tx = vec![2, 0, 0, 0, inputs];
    for prev in &prevs {
        tx.extend(double_sha256(prev));
        tx.extend([0; 4]);
        tx.push(0);
        tx.extend([0xfd, 0xff, 0xff, 0xff]);
    }
    tx.push(2);
    tx.extend(output(amount, to));
    tx.extend(output(COIN * inputs as u64 - amount - fee, &own_script()));
    tx.extend([0; 4]);
    let prev_txs: Vec<String> = prevs.iter().map(|p| STANDARD.encode(p)).collect();
    json!({
        "chain": "Bitcoin",
        "tx": STANDARD.encode(&tx),
        "meta": { "Bitcoin": { "prev_txs": prev_txs } },
    })
}

pub fn evm_proposal() -> Value {
    let tx = decode_hex(evm_vector()["serialized"].as_str().unwrap());
    json!({ "chain": "Evm", "tx": STANDARD.encode(tx), "meta": "Evm" })
}

fn policy(btc: &BtcCap) -> Value {
    let usdc = decode_hex(evm_vector()["token"].as_str().unwrap());
    json!({
        "caps": [
            { "asset": "Btc", "per_tx": btc.per_tx.to_string(), "per_24h": btc.per_24h.to_string(),
              "queue_at": btc.queue_at.to_string() },
            { "asset": { "Erc20": { "chain_id": 84532, "token": usdc } },
              "per_tx": "50000000", "per_24h": "200000000", "queue_at": "25000000" },
            { "asset": { "EvmNative": { "chain_id": 84532 } },
              "per_tx": "10000000000000000", "per_24h": "50000000000000000",
              "queue_at": "5000000000000000" }
        ],
        "payees": [
            { "chain": "Bitcoin", "to": payee_script(), "label": "supplier" },
            { "chain": "Evm", "to": vec![0xaau8; 20], "label": "supplier" }
        ],
        "btc_max_fee_rate": 1000,
        "btc_max_inputs": 8,
        "evm_chain_ids": [84532],
        "evm_max_gas_cost": "1000000000000000",
        "veto_delay_ns": 120000000000u64
    })
}

pub async fn setup(btc: &BtcCap) -> anyhow::Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let signer = worker.dev_deploy(&wasm(SIGNER_WASM)?).await?;
    let vault = worker.dev_deploy(&wasm(VAULT_WASM)?).await?;
    let root = worker.root_account()?;
    root.transfer_near(vault.id(), NearToken::from_near(5))
        .await?
        .into_result()?;
    let mut accounts = Vec::new();
    for name in ["owner", "guardian", "agent"] {
        accounts.push(
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(5))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let agent = accounts.pop().unwrap();
    let guardian = accounts.pop().unwrap();
    let owner = accounts.pop().unwrap();
    vault
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "guardian": guardian.id(),
            "agent": agent.id(),
            "signer": signer.id(),
            "paths": { "btc": "btc-vault-1", "evm": "evm-vault-1", "sol": "sol-vault-1" },
            "btc_pubkey": STANDARD.encode(PUBKEY),
            "evm_address": vec![9u8; 20],
            "policy": policy(btc),
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Setup {
        worker,
        vault,
        signer,
        owner,
        guardian,
        agent,
    })
}

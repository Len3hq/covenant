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
/// The vault's Ed25519 key in the sandbox.
pub const SOL_VAULT: [u8; 32] = [0x5a; 32];
pub const SOL_PAYEE: [u8; 32] = [0xaa; 32];
/// The payee's USDC token account, which is what a token payee lists.
pub const SOL_PAYEE_TOKENS: [u8; 32] = [0xab; 32];
pub const SOL_VAULT_TOKENS: [u8; 32] = [0x5b; 32];
pub const SOL_NONCE: [u8; 32] = [0x22; 32];
pub const SOL_USDC: [u8; 32] = [0x3b; 32];
pub const SYSTEM_PROGRAM: [u8; 32] = [0; 32];
pub const TOKEN_PROGRAM: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];
pub const COMPUTE_BUDGET_PROGRAM: [u8; 32] = [
    0x03, 0x06, 0x46, 0x6f, 0xe5, 0x21, 0x17, 0x32, 0xff, 0xec, 0xad, 0xba, 0x72, 0xc3, 0x9b, 0xe7,
    0xbc, 0x8c, 0xe5, 0xbb, 0xc5, 0xf7, 0x12, 0x6b, 0x2c, 0x43, 0x9b, 0x3a, 0x40, 0x00, 0x00, 0x00,
];
pub const RECENT_BLOCKHASHES_SYSVAR: [u8; 32] = [
    0x06, 0xa7, 0xd5, 0x17, 0x19, 0x2c, 0x56, 0x8e, 0xe0, 0x8a, 0x84, 0x5f, 0x73, 0xd2, 0x97, 0x88,
    0xcf, 0x03, 0x5c, 0x31, 0x45, 0xb2, 0x1a, 0xb3, 0x44, 0xd8, 0x06, 0x2e, 0xa9, 0x40, 0x00, 0x00,
];
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

fn short_vec(mut value: usize) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

/// A legacy Solana message from the vault. Keys are added in the order instructions name them.
pub struct SolMessage {
    pub header: [u8; 3],
    pub keys: Vec<[u8; 32]>,
    pub instructions: Vec<(usize, Vec<usize>, Vec<u8>)>,
}

impl SolMessage {
    /// Starts with the durable-nonce advance every vault message needs.
    pub fn new() -> Self {
        let message = SolMessage {
            header: [1, 0, 0],
            keys: vec![SOL_VAULT],
            instructions: vec![],
        };
        message.instruction(
            SYSTEM_PROGRAM,
            &[SOL_NONCE, RECENT_BLOCKHASHES_SYSVAR, SOL_VAULT],
            4u32.to_le_bytes().to_vec(),
        )
    }

    /// No nonce advance, so its blockhash would expire.
    pub fn without_nonce() -> Self {
        SolMessage {
            header: [1, 0, 0],
            keys: vec![SOL_VAULT],
            instructions: vec![],
        }
    }

    fn key(&mut self, key: [u8; 32]) -> usize {
        if let Some(index) = self.keys.iter().position(|k| *k == key) {
            return index;
        }
        self.keys.push(key);
        self.keys.len() - 1
    }

    pub fn instruction(mut self, program: [u8; 32], accounts: &[[u8; 32]], data: Vec<u8>) -> Self {
        let accounts = accounts.iter().map(|key| self.key(*key)).collect();
        let program = self.key(program);
        self.instructions.push((program, accounts, data));
        self
    }

    pub fn sol(self, from: [u8; 32], to: [u8; 32], lamports: u64) -> Self {
        let data = [2u32.to_le_bytes().to_vec(), lamports.to_le_bytes().to_vec()].concat();
        self.instruction(SYSTEM_PROGRAM, &[from, to], data)
    }

    pub fn token(self, mint: [u8; 32], to: [u8; 32], amount: u64) -> Self {
        let mut data = vec![12];
        data.extend(amount.to_le_bytes());
        data.push(6);
        self.instruction(
            TOKEN_PROGRAM,
            &[SOL_VAULT_TOKENS, mint, to, SOL_VAULT],
            data,
        )
    }

    pub fn priority(self, units: u32, micro_lamports: u64) -> Self {
        let limit = [vec![2], units.to_le_bytes().to_vec()].concat();
        let price = [vec![3], micro_lamports.to_le_bytes().to_vec()].concat();
        self.instruction(COMPUTE_BUDGET_PROGRAM, &[], limit)
            .instruction(COMPUTE_BUDGET_PROGRAM, &[], price)
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut out = self.header.to_vec();
        out.extend(short_vec(self.keys.len()));
        for key in &self.keys {
            out.extend(key);
        }
        out.extend([0x55; 32]);
        out.extend(short_vec(self.instructions.len()));
        for (program, accounts, data) in &self.instructions {
            out.push(*program as u8);
            out.extend(short_vec(accounts.len()));
            out.extend(accounts.iter().map(|index| *index as u8));
            out.extend(short_vec(data.len()));
            out.extend(data);
        }
        out
    }

    pub fn proposal(&self) -> Value {
        solana_proposal(&self.bytes())
    }
}

pub fn solana_proposal(message: &[u8]) -> Value {
    json!({ "chain": "Solana", "tx": STANDARD.encode(message), "meta": "Solana" })
}

pub fn policy(btc: &BtcCap) -> Value {
    let usdc = decode_hex(evm_vector()["token"].as_str().unwrap());
    json!({
        "caps": [
            { "asset": "Btc", "per_tx": btc.per_tx.to_string(), "per_24h": btc.per_24h.to_string(),
              "queue_at": btc.queue_at.to_string() },
            { "asset": { "Erc20": { "chain_id": 84532, "token": usdc } },
              "per_tx": "50000000", "per_24h": "200000000", "queue_at": "25000000" },
            { "asset": { "EvmNative": { "chain_id": 84532 } },
              "per_tx": "10000000000000000", "per_24h": "50000000000000000",
              "queue_at": "5000000000000000" },
            { "asset": "Sol", "per_tx": "100000000", "per_24h": "500000000",
              "queue_at": "50000000" },
            { "asset": { "Spl": { "mint": SOL_USDC } },
              "per_tx": "50000000", "per_24h": "200000000", "queue_at": "25000000" }
        ],
        "payees": [
            { "chain": "Bitcoin", "to": payee_script(), "label": "supplier" },
            { "chain": "Evm", "to": vec![0xaau8; 20], "label": "supplier" },
            { "chain": "Solana", "to": SOL_PAYEE, "label": "supplier" },
            { "chain": "Solana", "to": SOL_PAYEE_TOKENS, "label": "supplier USDC" }
        ],
        "btc_max_fee_rate": 1000,
        "btc_max_inputs": 8,
        "evm_chain_ids": [84532],
        "evm_max_gas_cost": "1000000000000000",
        "veto_delay_ns": 120000000000u64,
        "sol_max_fee": "100000"
    })
}

pub fn vault_wasm() -> anyhow::Result<Vec<u8>> {
    wasm(VAULT_WASM)
}

pub async fn setup(btc: &BtcCap) -> anyhow::Result<Setup> {
    setup_with(btc, &vault_wasm()?).await
}

/// `setup`, with other vault code, such as an earlier build to migrate from.
pub async fn setup_with(btc: &BtcCap, vault_code: &[u8]) -> anyhow::Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let signer = worker.dev_deploy(&wasm(SIGNER_WASM)?).await?;
    let vault = worker.dev_deploy(vault_code).await?;
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
            "sol_pubkey": SOL_VAULT,
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

//! Prints the README's gas table. Run with `cargo test -p covenant-integration-tests --test
//! gas_bench -- --nocapture`.

use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::types::NearToken;
use near_workspaces::{Contract, Worker};
use ripemd::Ripemd160;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

const BENCH_WASM: &str = "../../target/near/covenant_gas_bench/covenant_gas_bench.wasm";
const SIGNER_WASM: &str = "../../target/near/covenant_mock_signer/covenant_mock_signer.wasm";
const VAULT_WASM: &str = "../../target/near/covenant_vault/covenant_vault.wasm";
const PUBKEY: [u8; 33] = [0x02; 33];
const TGAS: u64 = 1_000_000_000_000;
const SIGN_TGAS: u64 = 30;
const CALLBACK_TGAS: u64 = 20;
const TX_GAS_LIMIT_TGAS: u64 = 300;
/// About the size of the vault's real faucet funding transactions.
const TYPICAL_PREV_TX: usize = 222;
const LARGE_PREV_TX: usize = 10_000;

/// The USDC transfer vector from viem.
fn evm_vector() -> Value {
    let vectors: Value = serde_json::from_str(include_str!("../../vectors/evm_hash.json")).unwrap();
    vectors["vectors"][1].clone()
}

fn decode_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .map_err(|e| anyhow::anyhow!("{path}: {e}. Run `make wasm` first."))
}

fn double_sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(bytes)).into()
}

fn own_script() -> Vec<u8> {
    let hash = Ripemd160::digest(Sha256::digest(PUBKEY));
    [vec![0x00, 0x14], hash.to_vec()].concat()
}

fn payee_script() -> Vec<u8> {
    [vec![0x00, 0x14], vec![0xaa; 20]].concat()
}

fn output(amount: u64, script: &[u8]) -> Vec<u8> {
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

/// A previous transaction of about `size` bytes paying the vault at output 0.
fn prev_tx(salt: u8, size: usize) -> Vec<u8> {
    let mut tx = vec![2, 0, 0, 0, 1];
    tx.extend([salt; 32]);
    tx.extend([0; 4]);
    tx.push(0);
    tx.extend([0xff; 4]);
    tx.push(2);
    tx.extend(output(100_000, &own_script()));
    let padding = size.saturating_sub(tx.len() + 16).max(1);
    tx.extend(output(1_000, &vec![0x51; padding]));
    tx.extend([0; 4]);
    tx
}

/// An unsigned spend of `inputs` coins, to a payee and change, with its `prev_txs`.
fn bitcoin_spend(inputs: u8, prev_size: usize) -> (Vec<u8>, Vec<Vec<u8>>) {
    let prevs: Vec<Vec<u8>> = (1..=inputs).map(|salt| prev_tx(salt, prev_size)).collect();
    let mut tx = vec![2, 0, 0, 0, inputs];
    for prev in &prevs {
        tx.extend(double_sha256(prev));
        tx.extend([0; 4]);
        tx.push(0);
        tx.extend([0xfd, 0xff, 0xff, 0xff]);
    }
    tx.push(2);
    tx.extend(output(50_000, &payee_script()));
    tx.extend(output(
        100_000 * inputs as u64 - 50_000 - 10_000,
        &own_script(),
    ));
    tx.extend([0; 4]);
    (tx, prevs)
}

async fn deploy(worker: &Worker<near_workspaces::network::Sandbox>) -> anyhow::Result<Contract> {
    let signer = worker.dev_deploy(&wasm(SIGNER_WASM)?).await?;
    let bench = worker.dev_deploy(&wasm(BENCH_WASM)?).await?;
    let usdc = decode_hex(evm_vector()["token"].as_str().unwrap());
    bench
        .call("new")
        .args_json(json!({
            "signer": signer.id(),
            "btc_pubkey": STANDARD.encode(PUBKEY),
            "policy": {
                "caps": [
                    { "asset": "Btc", "per_tx": "500000", "per_24h": "2000000", "queue_at": "250000" },
                    { "asset": { "Erc20": { "chain_id": 84532, "token": usdc } },
                      "per_tx": "50000000", "per_24h": "200000000", "queue_at": "25000000" }
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
            }
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(bench)
}

struct Measured {
    first_receipt: u64,
    total: u64,
}

/// Fails unless the callback saw a signature for every hash, so a gas number can't come from a
/// join in which `sign` quietly failed.
async fn measure(
    bench: &Contract,
    method: &str,
    args: Value,
    signatures: u64,
) -> anyhow::Result<Measured> {
    let outcome = bench
        .call(method)
        .args_json(args)
        .max_gas()
        .transact()
        .await?;
    let first_receipt = outcome.receipt_outcomes()[0].gas_burnt.as_gas();
    let total = outcome.total_gas_burnt.as_gas();
    assert_eq!(outcome.into_result()?.json::<u64>()?, signatures);
    Ok(Measured {
        first_receipt,
        total,
    })
}

fn tgas(gas: u64) -> String {
    format!("{}.{}", gas / TGAS, gas % TGAS * 10 / TGAS)
}

/// What the transaction must prepay: the proposal itself, plus the gas it forwards.
fn required(first_receipt: u64, signs: u64) -> u64 {
    first_receipt + (signs * SIGN_TGAS + CALLBACK_TGAS) * TGAS
}

#[tokio::test]
async fn measured_spends_fit_the_transaction_gas_limit() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let bench = deploy(&worker).await?;
    worker
        .root_account()?
        .transfer_near(bench.id(), NearToken::from_near(5))
        .await?
        .into_result()?;

    println!("| Spend | Prev tx size | Proposal receipt (Tgas) | Must prepay (Tgas) | Total burnt (Tgas) |");
    println!("| --- | --- | --- | --- | --- |");
    for inputs in [1u8, 2, 3, 5, 8] {
        for prev_size in [TYPICAL_PREV_TX, LARGE_PREV_TX] {
            let (tx, prevs) = bitcoin_spend(inputs, prev_size);
            let prev_txs: Vec<String> = prevs.iter().map(|p| STANDARD.encode(p)).collect();
            let measured = measure(
                &bench,
                "propose_bitcoin",
                json!({ "tx": STANDARD.encode(&tx), "meta": { "Bitcoin": { "prev_txs": prev_txs } } }),
                inputs as u64,
            )
            .await?;
            let must_prepay = required(measured.first_receipt, inputs as u64);
            println!(
                "| Bitcoin, {inputs} input(s) | {} bytes | {} | {} | {} |",
                prevs[0].len(),
                tgas(measured.first_receipt),
                tgas(must_prepay),
                tgas(measured.total),
            );
            assert!(must_prepay <= TX_GAS_LIMIT_TGAS * TGAS);
        }
    }

    let tx = decode_hex(evm_vector()["serialized"].as_str().unwrap());
    let measured = measure(
        &bench,
        "propose_evm",
        json!({ "tx": STANDARD.encode(&tx) }),
        1,
    )
    .await?;
    let must_prepay = required(measured.first_receipt, 1);
    println!(
        "| EVM, USDC transfer | n/a | {} | {} | {} |",
        tgas(measured.first_receipt),
        tgas(must_prepay),
        tgas(measured.total),
    );
    assert!(must_prepay <= TX_GAS_LIMIT_TGAS * TGAS);

    println!(
        "wasm: bench {} bytes, vault today {} bytes",
        wasm(BENCH_WASM)?.len(),
        wasm(VAULT_WASM)?.len()
    );
    Ok(())
}

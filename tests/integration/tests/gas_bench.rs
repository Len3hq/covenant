//! Prints the README's gas table, measured on the vault itself. Run with `cargo test -p
//! covenant-integration-tests --test gas_bench -- --nocapture`.

mod common;

use common::*;
use near_workspaces::Contract;
use serde_json::Value;

const VAULT_WASM: &str = "../../target/near/covenant_vault/covenant_vault.wasm";
const TGAS: u64 = 1_000_000_000_000;
const SIGN_TGAS: u64 = 30;
const CALLBACK_TGAS: u64 = 20;
const TX_GAS_LIMIT_TGAS: u64 = 300;
/// About the size of the vault's real faucet funding transactions.
const TYPICAL_PREV_TX: usize = 222;
const LARGE_PREV_TX: usize = 10_000;

struct Measured {
    first_receipt: u64,
    total: u64,
}

/// Fails unless the callback saw a signature for every hash, so a gas number can't come from a
/// join in which `sign` quietly failed.
async fn measure(
    agent: &near_workspaces::Account,
    vault: &Contract,
    args: Value,
    signatures: usize,
) -> anyhow::Result<Measured> {
    let outcome = agent
        .call(vault.id(), "propose_spend")
        .args_json(args)
        .max_gas()
        .transact()
        .await?;
    let first_receipt = outcome.receipt_outcomes()[0].gas_burnt.as_gas();
    let total = outcome.total_gas_burnt.as_gas();
    let result: Value = outcome.into_result()?.json()?;
    assert_eq!(
        result["Signed"]["signatures"].as_array().map(Vec::len),
        Some(signatures),
        "{result}"
    );
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
    let s = setup(&ROOMY).await?;

    println!("| Spend | Prev tx size | Proposal receipt (Tgas) | Must prepay (Tgas) | Total burnt (Tgas) |");
    println!("| --- | --- | --- | --- | --- |");
    for inputs in [1u8, 2, 3, 5, 8] {
        for prev_size in [TYPICAL_PREV_TX, LARGE_PREV_TX] {
            let args = bitcoin_proposal(inputs, prev_size, &payee_script(), 50_000, 10_000);
            let measured = measure(&s.agent, &s.vault, args, inputs as usize).await?;
            let must_prepay = required(measured.first_receipt, inputs as u64);
            println!(
                "| Bitcoin, {inputs} input(s) | about {prev_size} bytes | {} | {} | {} |",
                tgas(measured.first_receipt),
                tgas(must_prepay),
                tgas(measured.total),
            );
            assert!(must_prepay <= TX_GAS_LIMIT_TGAS * TGAS);
        }
    }

    let measured = measure(&s.agent, &s.vault, evm_proposal(), 1).await?;
    let must_prepay = required(measured.first_receipt, 1);
    println!(
        "| EVM, USDC transfer | n/a | {} | {} | {} |",
        tgas(measured.first_receipt),
        tgas(must_prepay),
        tgas(measured.total),
    );
    assert!(must_prepay <= TX_GAS_LIMIT_TGAS * TGAS);

    for (name, message) in [
        (
            "Solana, SOL transfer",
            SolMessage::new().sol(SOL_VAULT, SOL_PAYEE, 1_000_000),
        ),
        (
            "Solana, USDC transfer with priority fee",
            SolMessage::new()
                .token(SOL_USDC, SOL_PAYEE_TOKENS, 1_000_000)
                .priority(10_000, 1_000_000),
        ),
    ] {
        let measured = measure(&s.agent, &s.vault, message.proposal(), 1).await?;
        let must_prepay = required(measured.first_receipt, 1);
        println!(
            "| {name} | n/a | {} | {} | {} |",
            tgas(measured.first_receipt),
            tgas(must_prepay),
            tgas(measured.total),
        );
        assert!(must_prepay <= TX_GAS_LIMIT_TGAS * TGAS);
    }

    println!("wasm: vault {} bytes", wasm(VAULT_WASM)?.len());
    Ok(())
}

//! Solana attacks by a hijacked agent, sent to the real contract. Each one must end with no
//! signature requested and no budget used. Only a durable-nonce message from the vault that moves
//! SOL or a capped SPL token to listed payees may be signed.

#[path = "../integration/tests/common/mod.rs"]
mod common;

use common::*;
use serde_json::{json, Value};

const ATTACKER: [u8; 32] = [0xba; 32];
const ATTACKER_TOKENS: [u8; 32] = [0xbc; 32];
const OTHER_MINT: [u8; 32] = [0x44; 32];
const TOKEN_2022: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde, 0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27, 0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
];

/// Runs the attack and returns the contract's answer, having checked that nothing was signed.
async fn refused(message: Vec<u8>) -> anyhow::Result<String> {
    let s = setup(&ROOMY).await?;
    let outcome = s
        .agent
        .call(s.vault.id(), "propose_spend")
        .args_json(solana_proposal(&message))
        .max_gas()
        .transact()
        .await?;
    let answer = format!("{:?}", outcome.into_result().map(|r| r.json::<Value>()));
    let calls: u64 = s.signer.view("get_calls").await?.json()?;
    assert_eq!(calls, 0, "an attack reached the signer: {answer}");
    for asset in [json!("Sol"), json!({ "Spl": { "mint": SOL_USDC } })] {
        let spent: String = s
            .vault
            .view("get_spent_24h")
            .args_json(json!({ "asset": asset }))
            .await?
            .json()?;
        assert_eq!(spent, "0", "an attack used budget: {answer}");
    }
    Ok(answer)
}

fn assert_named(answer: &str, error: &str) {
    assert!(answer.contains(error), "expected {error}, got {answer}");
}

#[tokio::test]
async fn attack_sends_sol_to_the_attacker() -> anyhow::Result<()> {
    let message = SolMessage::new()
        .sol(SOL_VAULT, ATTACKER, 1_000_000)
        .bytes();
    assert_named(&refused(message).await?, "OutputNotWhitelisted");
    Ok(())
}

#[tokio::test]
async fn attack_sends_usdc_to_the_attackers_token_account() -> anyhow::Result<()> {
    let message = SolMessage::new()
        .token(SOL_USDC, ATTACKER_TOKENS, 1)
        .bytes();
    assert_named(&refused(message).await?, "OutputNotWhitelisted");
    Ok(())
}

#[tokio::test]
async fn attack_hides_a_second_payment_behind_an_honest_one() -> anyhow::Result<()> {
    let message = SolMessage::new()
        .sol(SOL_VAULT, SOL_PAYEE, 1_000)
        .sol(SOL_VAULT, ATTACKER, 1_000_000)
        .bytes();
    assert_named(&refused(message).await?, "OutputNotWhitelisted");
    Ok(())
}

#[tokio::test]
async fn attack_approves_the_attacker_as_delegate() -> anyhow::Result<()> {
    // SPL Token Approve: the attacker could then move the vault's tokens without it signing.
    let mut data = vec![4];
    data.extend(u64::MAX.to_le_bytes());
    let message = SolMessage::new()
        .instruction(
            TOKEN_PROGRAM,
            &[SOL_VAULT_TOKENS, ATTACKER, SOL_VAULT],
            data,
        )
        .bytes();
    assert_named(&refused(message).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_hands_the_token_account_to_the_attacker() -> anyhow::Result<()> {
    // SetAuthority, AccountOwner, to the attacker.
    let data = [vec![6, 2, 1], ATTACKER.to_vec()].concat();
    let message = SolMessage::new()
        .instruction(TOKEN_PROGRAM, &[SOL_VAULT_TOKENS, SOL_VAULT], data)
        .bytes();
    assert_named(&refused(message).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_assigns_the_vault_account_to_the_attackers_program() -> anyhow::Result<()> {
    let data = [1u32.to_le_bytes().to_vec(), ATTACKER.to_vec()].concat();
    let message = SolMessage::new()
        .instruction(SYSTEM_PROGRAM, &[SOL_VAULT], data)
        .bytes();
    assert_named(&refused(message).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_calls_the_attackers_program() -> anyhow::Result<()> {
    let message = SolMessage::new()
        .instruction(ATTACKER, &[SOL_VAULT, SOL_VAULT_TOKENS], vec![0xde, 0xad])
        .bytes();
    assert_named(&refused(message).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_moves_tokens_through_token_2022() -> anyhow::Result<()> {
    let mut data = vec![12];
    data.extend(1u64.to_le_bytes());
    data.push(6);
    let message = SolMessage::new()
        .instruction(
            TOKEN_2022,
            &[SOL_VAULT_TOKENS, SOL_USDC, SOL_PAYEE_TOKENS, SOL_VAULT],
            data,
        )
        .bytes();
    assert_named(&refused(message).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_pays_in_an_uncapped_token() -> anyhow::Result<()> {
    let message = SolMessage::new()
        .token(OTHER_MINT, SOL_PAYEE_TOKENS, 1)
        .bytes();
    assert_named(&refused(message).await?, "TokenNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_burns_the_vault_through_priority_fees() -> anyhow::Result<()> {
    let message = SolMessage::new()
        .sol(SOL_VAULT, SOL_PAYEE, 1_000)
        .priority(1_400_000, 1_000_000_000)
        .bytes();
    assert_named(&refused(message).await?, "FeeTooHigh");
    Ok(())
}

#[tokio::test]
async fn attack_pays_more_than_the_per_tx_cap() -> anyhow::Result<()> {
    let message = SolMessage::new()
        .sol(SOL_VAULT, SOL_PAYEE, 200_000_000)
        .bytes();
    assert_named(&refused(message).await?, "PerTxCapExceeded");
    Ok(())
}

#[tokio::test]
async fn attack_spends_from_a_message_another_key_pays_for() -> anyhow::Result<()> {
    let mut message = SolMessage::new().sol(SOL_VAULT, SOL_PAYEE, 1_000);
    message.keys[0] = ATTACKER;
    assert_named(&refused(message.bytes()).await?, "InputNotOwned");
    Ok(())
}

#[tokio::test]
async fn attack_skips_the_nonce_advance() -> anyhow::Result<()> {
    let message = SolMessage::without_nonce()
        .sol(SOL_VAULT, SOL_PAYEE, 1_000)
        .bytes();
    assert_named(&refused(message).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_uses_a_versioned_message_with_lookup_tables() -> anyhow::Result<()> {
    // The table could swap any account in, out of the contract's sight.
    let mut message = vec![0x80];
    message.extend(SolMessage::new().sol(SOL_VAULT, SOL_PAYEE, 1_000).bytes());
    message.extend([1]);
    message.extend(ATTACKER);
    message.extend([1, 0, 0]);
    assert_named(&refused(message).await?, "MalformedTx");
    Ok(())
}

#[tokio::test]
async fn attack_adds_a_second_signer() -> anyhow::Result<()> {
    let mut message = SolMessage::new().sol(SOL_VAULT, SOL_PAYEE, 1_000);
    message.header = [2, 0, 0];
    assert_named(&refused(message.bytes()).await?, "MalformedTx");
    Ok(())
}

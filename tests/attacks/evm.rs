//! EVM attacks by a hijacked agent, sent to the real contract. Each one must end with no
//! signature requested and no budget used. Only a plain transfer to a listed payee, or an exact
//! ERC-20 `transfer` of a listed token to a listed payee, may be signed.

#[path = "../integration/tests/common/mod.rs"]
mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::*;
use serde_json::{json, Value};

const CHAIN: u128 = 84532;
const PAYEE: [u8; 20] = [0xaa; 20];
const ATTACKER: [u8; 20] = [0xba; 20];
const APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
const TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const TRANSFER_FROM: [u8; 4] = [0x23, 0xb8, 0x72, 0xdd];
const INCREASE_ALLOWANCE: [u8; 4] = [0x39, 0x50, 0x93, 0x51];
const PERMIT: [u8; 4] = [0xd5, 0x05, 0xac, 0xcf];

fn rlp_length(base: u8, length: usize) -> Vec<u8> {
    if length < 56 {
        return vec![base + length as u8];
    }
    let encoded: Vec<u8> = length
        .to_be_bytes()
        .into_iter()
        .skip_while(|byte| *byte == 0)
        .collect();
    [vec![base + 55 + encoded.len() as u8], encoded].concat()
}

fn rlp_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        return bytes.to_vec();
    }
    [rlp_length(0x80, bytes.len()), bytes.to_vec()].concat()
}

fn rlp_int(value: u128) -> Vec<u8> {
    let bytes: Vec<u8> = value
        .to_be_bytes()
        .into_iter()
        .skip_while(|byte| *byte == 0)
        .collect();
    rlp_bytes(&bytes)
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload = items.concat();
    [rlp_length(0xc0, payload.len()), payload].concat()
}

fn usdc() -> Vec<u8> {
    decode_hex(evm_vector()["token"].as_str().unwrap())
}

/// An ABI word holding an address.
fn address_word(address: &[u8]) -> Vec<u8> {
    [vec![0; 12], address.to_vec()].concat()
}

fn amount_word(amount: u128) -> Vec<u8> {
    [vec![0; 16], amount.to_be_bytes().to_vec()].concat()
}

fn call(selector: [u8; 4], words: &[Vec<u8>]) -> Vec<u8> {
    [selector.to_vec(), words.concat()].concat()
}

struct Tx {
    kind: u8,
    chain_id: u128,
    max_fee: u128,
    gas: u128,
    to: Vec<u8>,
    value: u128,
    data: Vec<u8>,
}

impl Tx {
    fn native(to: [u8; 20], value: u128) -> Self {
        Tx {
            kind: 0x02,
            chain_id: CHAIN,
            max_fee: 1_000_000,
            gas: 21_000,
            to: to.to_vec(),
            value,
            data: vec![],
        }
    }

    fn token(data: Vec<u8>) -> Self {
        Tx {
            to: usdc(),
            value: 0,
            gas: 65_000,
            data,
            ..Tx::native(PAYEE, 0)
        }
    }

    fn args(&self) -> Value {
        let items = rlp_list(&[
            rlp_int(self.chain_id),
            rlp_int(3),
            rlp_int(1_000),
            rlp_int(self.max_fee),
            rlp_int(self.gas),
            rlp_bytes(&self.to),
            rlp_int(self.value),
            rlp_bytes(&self.data),
            rlp_list(&[]),
        ]);
        let tx = [vec![self.kind], items].concat();
        json!({ "chain": "Evm", "tx": STANDARD.encode(tx), "meta": "Evm" })
    }
}

/// Runs the attack and returns the contract's answer, having checked that nothing was signed.
async fn refused(tx: Tx) -> anyhow::Result<String> {
    let s = setup(&ROOMY).await?;
    let outcome = s
        .agent
        .call(s.vault.id(), "propose_spend")
        .args_json(tx.args())
        .max_gas()
        .transact()
        .await?;
    let answer = format!("{:?}", outcome.into_result().map(|r| r.json::<Value>()));
    let calls: u64 = s.signer.view("get_calls").await?.json()?;
    assert_eq!(calls, 0, "an attack reached the signer: {answer}");
    for asset in [
        json!({ "EvmNative": { "chain_id": 84532 } }),
        json!({ "Erc20": { "chain_id": 84532, "token": usdc() } }),
    ] {
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
async fn attack_approves_the_attacker_for_unlimited_tokens() -> anyhow::Result<()> {
    let data = call(APPROVE, &[address_word(&ATTACKER), vec![0xff; 32]]);
    assert_named(&refused(Tx::token(data)).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_raises_the_attackers_allowance() -> anyhow::Result<()> {
    let data = call(
        INCREASE_ALLOWANCE,
        &[address_word(&ATTACKER), vec![0xff; 32]],
    );
    assert_named(&refused(Tx::token(data)).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_signs_a_permit() -> anyhow::Result<()> {
    let words = vec![vec![0; 32]; 7];
    assert_named(
        &refused(Tx::token(call(PERMIT, &words))).await?,
        "CalldataNotAllowed",
    );
    Ok(())
}

#[tokio::test]
async fn attack_moves_tokens_with_transfer_from() -> anyhow::Result<()> {
    let data = call(
        TRANSFER_FROM,
        &[
            address_word(&[0x7e; 20]),
            address_word(&ATTACKER),
            amount_word(1),
        ],
    );
    assert_named(&refused(Tx::token(data)).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_transfers_tokens_to_the_attacker() -> anyhow::Result<()> {
    let data = call(TRANSFER, &[address_word(&ATTACKER), amount_word(1_000_000)]);
    assert_named(&refused(Tx::token(data)).await?, "OutputNotWhitelisted");
    Ok(())
}

#[tokio::test]
async fn attack_sends_ether_to_the_attacker() -> anyhow::Result<()> {
    assert_named(
        &refused(Tx::native(ATTACKER, 1_000)).await?,
        "OutputNotWhitelisted",
    );
    Ok(())
}

#[tokio::test]
async fn attack_hides_the_attacker_in_dirty_address_padding() -> anyhow::Result<()> {
    // A parser that reads only the low 20 bytes would see the payee here.
    let mut word = address_word(&PAYEE);
    word[0] = 0xba;
    let data = call(TRANSFER, &[word, amount_word(1_000_000)]);
    assert_named(&refused(Tx::token(data)).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_appends_calldata_to_a_transfer() -> anyhow::Result<()> {
    let mut data = call(TRANSFER, &[address_word(&PAYEE), amount_word(1_000_000)]);
    data.extend(address_word(&ATTACKER));
    assert_named(&refused(Tx::token(data)).await?, "CalldataNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_calls_an_unlisted_contract() -> anyhow::Result<()> {
    let data = call(TRANSFER, &[address_word(&PAYEE), amount_word(1)]);
    let tx = Tx {
        to: ATTACKER.to_vec(),
        ..Tx::token(data)
    };
    assert_named(&refused(tx).await?, "TokenNotAllowed");
    Ok(())
}

#[tokio::test]
async fn attack_sends_ether_alongside_a_token_call() -> anyhow::Result<()> {
    let data = call(TRANSFER, &[address_word(&PAYEE), amount_word(1)]);
    let tx = Tx {
        value: 1_000,
        ..Tx::token(data)
    };
    assert_named(&refused(tx).await?, "ValueWithTokenCall");
    Ok(())
}

#[tokio::test]
async fn attack_replays_the_spend_on_another_chain() -> anyhow::Result<()> {
    let tx = Tx {
        chain_id: 1,
        ..Tx::native(PAYEE, 1_000)
    };
    assert_named(&refused(tx).await?, "WrongChainId");
    Ok(())
}

#[tokio::test]
async fn attack_burns_the_vault_through_gas() -> anyhow::Result<()> {
    let tx = Tx {
        max_fee: 1_000_000_000_000,
        ..Tx::native(PAYEE, 1_000)
    };
    assert_named(&refused(tx).await?, "GasCostTooHigh");
    Ok(())
}

#[tokio::test]
async fn attack_pays_more_than_the_per_tx_cap() -> anyhow::Result<()> {
    let data = call(TRANSFER, &[address_word(&PAYEE), amount_word(60_000_000)]);
    assert_named(&refused(Tx::token(data)).await?, "PerTxCapExceeded");
    Ok(())
}

#[tokio::test]
async fn attack_uses_an_older_or_newer_transaction_type() -> anyhow::Result<()> {
    // Type 4 can delegate the vault's whole account to the attacker's code (EIP-7702).
    for kind in [0x00, 0x01, 0x04] {
        let tx = Tx {
            kind,
            ..Tx::native(PAYEE, 1_000)
        };
        assert_named(&refused(tx).await?, "MalformedTx");
    }
    Ok(())
}

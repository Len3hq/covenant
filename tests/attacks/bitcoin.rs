//! Bitcoin attacks by a hijacked agent, sent to the real contract. Each one must end with no
//! signature requested and no budget used, whatever the agent's key is allowed to call.

#[path = "../integration/tests/common/mod.rs"]
mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::*;
use serde_json::{json, Value};

const CAPS: BtcCap = BtcCap {
    per_tx: 90_000,
    per_24h: 500_000,
    queue_at: 60_000,
};

struct Attack {
    inputs: Vec<(Vec<u8>, [u8; 32], u32)>,
    outputs: Vec<(u64, Vec<u8>)>,
    locktime: u32,
    script_sig: Vec<u8>,
}

impl Attack {
    /// `inputs` of the vault's own coins, with the given outputs.
    fn new(inputs: u8, outputs: Vec<(u64, Vec<u8>)>) -> Self {
        let inputs = (1..=inputs)
            .map(|salt| {
                let prev = prev_tx(salt, 222);
                let txid = double_sha256(&prev);
                (prev, txid, 0)
            })
            .collect();
        Attack {
            inputs,
            outputs,
            locktime: 0,
            script_sig: vec![],
        }
    }

    fn tx(&self) -> Vec<u8> {
        let mut tx = vec![2, 0, 0, 0, self.inputs.len() as u8];
        for (_, txid, vout) in &self.inputs {
            tx.extend(txid);
            tx.extend(vout.to_le_bytes());
            tx.push(self.script_sig.len() as u8);
            tx.extend(&self.script_sig);
            tx.extend([0xfd, 0xff, 0xff, 0xff]);
        }
        tx.push(self.outputs.len() as u8);
        for (amount, script) in &self.outputs {
            tx.extend(output(*amount, script));
        }
        tx.extend(self.locktime.to_le_bytes());
        tx
    }

    fn args(&self) -> Value {
        args(
            &self.tx(),
            self.inputs.iter().map(|(prev, ..)| prev.clone()),
        )
    }
}

fn args(tx: &[u8], prevs: impl Iterator<Item = Vec<u8>>) -> Value {
    let prev_txs: Vec<String> = prevs.map(|prev| STANDARD.encode(prev)).collect();
    json!({
        "chain": "Bitcoin",
        "tx": STANDARD.encode(tx),
        "meta": { "Bitcoin": { "prev_txs": prev_txs } },
    })
}

/// Runs the attack and returns the contract's answer, having checked that nothing was signed.
async fn refused(args: Value) -> anyhow::Result<String> {
    let s = setup(&CAPS).await?;
    let policy: Value = s.vault.view("get_policy").await?.json()?;
    let mut policy = policy;
    policy["btc_max_fee_rate"] = json!(50);
    s.owner
        .call(s.vault.id(), "set_policy")
        .args_json(json!({ "policy": policy }))
        .transact()
        .await?
        .into_result()?;
    let outcome = s
        .agent
        .call(s.vault.id(), "propose_spend")
        .args_json(args)
        .max_gas()
        .transact()
        .await?;
    let answer = format!(
        "{:?}",
        outcome.clone().into_result().map(|r| r.json::<Value>())
    );
    let calls: u64 = s.signer.view("get_calls").await?.json()?;
    assert_eq!(calls, 0, "an attack reached the signer: {answer}");
    let spent: String = s
        .vault
        .view("get_spent_24h")
        .args_json(json!({ "asset": "Btc" }))
        .await?
        .json()?;
    assert_eq!(spent, "0", "an attack used budget: {answer}");
    Ok(answer)
}

fn assert_named(answer: &str, error: &str) {
    assert!(answer.contains(error), "expected {error}, got {answer}");
}

fn change(amount: u64) -> (u64, Vec<u8>) {
    (amount, own_script())
}

#[tokio::test]
async fn attack_pays_the_attacker_directly() -> anyhow::Result<()> {
    let attack = Attack::new(1, vec![(99_000, stranger_script())]);
    assert_named(&refused(attack.args()).await?, "OutputNotWhitelisted");
    Ok(())
}

#[tokio::test]
async fn attack_hides_the_attacker_among_honest_outputs() -> anyhow::Result<()> {
    let attack = Attack::new(
        1,
        vec![
            (10_000, payee_script()),
            (1_000, stranger_script()),
            change(88_000),
        ],
    );
    assert_named(&refused(attack.args()).await?, "OutputNotWhitelisted");
    Ok(())
}

#[tokio::test]
async fn attack_sends_the_change_to_the_attacker() -> anyhow::Result<()> {
    let attack = Attack::new(
        1,
        vec![(10_000, payee_script()), (89_000, stranger_script())],
    );
    assert_named(&refused(attack.args()).await?, "OutputNotWhitelisted");
    Ok(())
}

#[tokio::test]
async fn attack_burns_the_vault_through_fees() -> anyhow::Result<()> {
    let attack = Attack::new(1, vec![(10_000, payee_script())]);
    assert_named(&refused(attack.args()).await?, "FeeTooHigh");
    Ok(())
}

#[tokio::test]
async fn attack_splits_a_large_payment_past_the_per_tx_cap() -> anyhow::Result<()> {
    let attack = Attack::new(
        2,
        vec![
            (30_000, payee_script()),
            (30_000, payee_script()),
            (35_000, payee_script()),
            change(100_000),
        ],
    );
    assert_named(&refused(attack.args()).await?, "PerTxCapExceeded");
    Ok(())
}

#[tokio::test]
async fn attack_lies_about_a_coins_value() -> anyhow::Result<()> {
    // The input claims a richer previous transaction than the one its outpoint commits to.
    let attack = Attack::new(1, vec![(10_000, payee_script()), change(89_000)]);
    let mut richer = attack.inputs[0].0.clone();
    let amount_at = richer.len() - 4 - 8 - 2;
    richer[amount_at] ^= 0x01;
    let tampered = args(&attack.tx(), std::iter::once(richer));
    assert_named(&refused(tampered).await?, "PrevTxMismatch");
    Ok(())
}

#[tokio::test]
async fn attack_gets_a_foreign_coin_signed() -> anyhow::Result<()> {
    // A coin paying someone else: signing it could spend funds at another key's expense.
    let mut prev = vec![2, 0, 0, 0, 1];
    prev.extend([9; 32]);
    prev.extend([0; 4]);
    prev.push(0);
    prev.extend([0xff; 4]);
    prev.push(1);
    prev.extend(output(100_000, &stranger_script()));
    prev.extend([0; 4]);
    let mut attack = Attack::new(1, vec![(10_000, payee_script()), change(89_000)]);
    attack.inputs = vec![(prev.clone(), double_sha256(&prev), 0)];
    assert_named(&refused(attack.args()).await?, "InputNotOwned");
    Ok(())
}

#[tokio::test]
async fn attack_uses_more_inputs_than_the_gas_limit_allows() -> anyhow::Result<()> {
    let attack = Attack::new(9, vec![(10_000, payee_script()), change(889_000)]);
    assert_named(&refused(attack.args()).await?, "TooManyInputs");
    Ok(())
}

#[tokio::test]
async fn attack_hides_data_in_an_op_return() -> anyhow::Result<()> {
    let attack = Attack::new(
        1,
        vec![
            (10_000, payee_script()),
            (546, vec![0x6a, 0x04, 1, 2, 3, 4]),
            change(88_000),
        ],
    );
    assert_named(&refused(attack.args()).await?, "UnsupportedScript");
    Ok(())
}

#[tokio::test]
async fn attack_delays_the_spend_with_a_locktime() -> anyhow::Result<()> {
    let mut attack = Attack::new(1, vec![(10_000, payee_script()), change(89_000)]);
    attack.locktime = 500_000;
    assert_named(&refused(attack.args()).await?, "MalformedTx");
    Ok(())
}

#[tokio::test]
async fn attack_adds_a_script_sig() -> anyhow::Result<()> {
    let mut attack = Attack::new(1, vec![(10_000, payee_script()), change(89_000)]);
    attack.script_sig = vec![0x51];
    assert_named(&refused(attack.args()).await?, "MalformedTx");
    Ok(())
}

#[tokio::test]
async fn attack_spends_one_coin_twice_in_a_transaction() -> anyhow::Result<()> {
    let mut attack = Attack::new(1, vec![(10_000, payee_script()), change(189_000)]);
    attack.inputs.push(attack.inputs[0].clone());
    assert_named(&refused(attack.args()).await?, "MalformedTx");
    Ok(())
}

/// The agent can't skip the checks by asking for a signature directly: nothing takes a hash.
#[tokio::test]
async fn attack_asks_the_vault_to_sign_a_hash() -> anyhow::Result<()> {
    let s = setup(&CAPS).await?;
    let hash = "11".repeat(32);
    for (method, args) in [
        ("sign", json!({ "payload": hash })),
        ("sign_hash", json!({ "hash": hash })),
        ("on_signed", json!({})),
    ] {
        let outcome = s
            .agent
            .call(s.vault.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?;
        assert!(
            outcome.into_result().is_err(),
            "{method} accepted a call from the agent"
        );
    }
    let calls: u64 = s.signer.view("get_calls").await?.json()?;
    assert_eq!(calls, 0);
    Ok(())
}

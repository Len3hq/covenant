//! Throwaway contract for the M0 signing spike. Only its own account can call it, and the keys it
//! derives never hold funds. Delete it once the vault signs for real at M3.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

const MAX_RESULT_BYTES: usize = 1024;

#[near(contract_state)]
#[derive(Default)]
pub struct Spike {}

#[near]
impl Spike {
    /// Fires one `sign` per payload, joined with `Promise::and`, then returns every result.
    pub fn sign_many(
        &mut self,
        signer: AccountId,
        path: String,
        domain_id: u32,
        payloads: Vec<String>,
        sign_tgas: u64,
        callback_tgas: u64,
    ) -> Promise {
        if env::predecessor_account_id() != env::current_account_id() {
            env::panic_str("self only");
        }
        let count = payloads.len() as u64;
        let joined = payloads
            .into_iter()
            .map(|payload| {
                let args = json!({
                    "request": {
                        "payload_v2": { "Ecdsa": payload },
                        "path": path,
                        "domain_id": domain_id,
                    }
                });
                Promise::new(signer.clone()).function_call(
                    "sign".to_string(),
                    args.to_string().into_bytes(),
                    NearToken::from_yoctonear(1),
                    Gas::from_tgas(sign_tgas),
                )
            })
            .reduce(Promise::and)
            .unwrap_or_else(|| env::panic_str("no payloads"));
        joined.then(
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(callback_tgas))
                .on_signed(count),
        )
    }

    #[private]
    pub fn on_signed(&self, count: u64) -> Vec<Value> {
        (0..count)
            .map(|i| {
                env::promise_result_checked(i, MAX_RESULT_BYTES)
                    .ok()
                    .and_then(|bytes| near_sdk::serde_json::from_slice(&bytes).ok())
                    .unwrap_or(Value::Null)
            })
            .collect()
    }
}

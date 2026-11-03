//! Measures what `propose_spend` will cost before the vault is wired up: state load, adapter parse,
//! hashes, then one `sign` per hash joined into a callback. It has no access control, so it only
//! ever runs in the sandbox against the mock signer.

use covenant_adapter_bitcoin::BitcoinVault;
use covenant_policy::{ParsedTx, Policy, TxMeta};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const SIGN_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct GasBench {
    signer: AccountId,
    btc_pubkey: [u8; 33],
    policy: Policy,
}

#[near]
impl GasBench {
    #[init]
    pub fn new(signer: AccountId, btc_pubkey: Base64VecU8, policy: Policy) -> Self {
        let btc_pubkey = btc_pubkey
            .0
            .try_into()
            .unwrap_or_else(|_| env::panic_str("btc_pubkey must be 33 bytes"));
        Self {
            signer,
            btc_pubkey,
            policy,
        }
    }

    pub fn propose_bitcoin(&mut self, tx: Base64VecU8, meta: TxMeta) -> Promise {
        let vault = BitcoinVault {
            pubkey: &self.btc_pubkey,
        };
        let parsed = covenant_adapter_bitcoin::parse(&tx.0, &meta, &self.policy, &vault);
        self.sign_all(parsed, "btc-vault-1")
    }

    pub fn propose_evm(&mut self, tx: Base64VecU8) -> Promise {
        let parsed = covenant_adapter_evm::parse(&tx.0, &self.policy);
        self.sign_all(parsed, "evm-vault-1")
    }

    #[private]
    pub fn on_signed(&self, count: u64) -> u64 {
        (0..count)
            .filter(|index| env::promise_result_checked(*index, 1024).is_ok())
            .count() as u64
    }
}

impl GasBench {
    fn sign_all(
        &self,
        parsed: Result<ParsedTx, covenant_policy::CovenantError>,
        path: &str,
    ) -> Promise {
        let parsed = parsed.unwrap_or_else(|error| env::panic_str(&error.to_string()));
        let count = parsed.signing_hashes.len() as u64;
        parsed
            .signing_hashes
            .iter()
            .map(|hash| {
                let args = json!({
                    "request": {
                        "payload_v2": { "Ecdsa": hex::encode(hash) },
                        "path": path,
                        "domain_id": 0,
                    }
                });
                Promise::new(self.signer.clone()).function_call(
                    "sign".to_string(),
                    args.to_string().into_bytes(),
                    NearToken::from_yoctonear(1),
                    SIGN_GAS,
                )
            })
            .reduce(Promise::and)
            .unwrap_or_else(|| env::panic_str("nothing to sign"))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_signed(count),
            )
    }
}

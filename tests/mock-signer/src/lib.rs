//! Mirrors the `sign` interface of `v1.signer-prod.testnet`, including its deposit and gas checks.
//! Signatures are deterministic and not valid. The response shape is copied from live responses
//! recorded in docs/SPIKE.md.

use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

/// The live contract refuses less, despite its docs saying 10 Tgas. See docs/SPIKE.md.
const MIN_SIGN_GAS: Gas = Gas::from_tgas(15);

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignRequest {
    pub payload_v2: Payload,
    pub path: String,
    pub domain_id: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scalar {
    pub scalar: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignResponse {
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[near(contract_state)]
#[derive(Default)]
pub struct MockSigner {
    fail: bool,
    fail_after: Option<u64>,
    calls: u64,
}

#[near]
impl MockSigner {
    /// Makes every later `sign` fail, to exercise `SignFailed` handling.
    pub fn set_fail(&mut self, fail: bool) {
        self.fail = fail;
    }

    /// Fails every `sign` once `calls` have succeeded, to exercise a partly failed join.
    pub fn set_fail_after(&mut self, calls: Option<u64>) {
        self.fail_after = calls;
    }

    pub fn get_calls(&self) -> u64 {
        self.calls
    }

    /// A per-account, per-path key, so vaults get different addresses. It isn't on the curve, which
    /// nothing here needs: the factory's own tests pin the arithmetic to a real key.
    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: AccountId,
        domain_id: u32,
    ) -> String {
        if self.fail {
            env::panic_str("mock signer: failing on demand");
        }
        let x = env::sha256(format!("{predecessor}/{path}/{domain_id}").as_bytes());
        let point = [x.clone(), env::sha256(&x)].concat();
        format!("secp256k1:{}", near_sdk::bs58::encode(point).into_string())
    }

    /// Publishes code as a global contract, which near-workspaces has no transaction for.
    pub fn publish_global(&mut self, code: Base64VecU8) -> Promise {
        Promise::new(env::current_account_id()).deploy_global_contract(code.0)
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> SignResponse {
        if env::attached_deposit() < NearToken::from_yoctonear(1) {
            env::panic_str("sign requires a deposit of at least 1 yoctonear");
        }
        if env::prepaid_gas() < MIN_SIGN_GAS {
            env::panic_str("Provided gas is lower than required");
        }
        if self.fail || self.fail_after.is_some_and(|calls| self.calls >= calls) {
            env::panic_str("mock signer: failing on demand");
        }
        let Payload::Ecdsa(payload) = request.payload_v2 else {
            env::panic_str("mock signer: only Ecdsa is supported");
        };
        if payload.len() != 64 {
            env::panic_str("Ecdsa payload must be 32 bytes of hex");
        }
        self.calls += 1;
        SignResponse {
            scheme: "Secp256k1".to_string(),
            big_r: AffinePoint {
                affine_point: format!("02{payload}"),
            },
            s: Scalar { scalar: payload },
            recovery_id: 0,
        }
    }
}

//! The vault contract. Adapters turn a raw transaction into payments and signing hashes, the
//! policy crate decides, and this contract orchestrates: it reserves budget, queues or signs,
//! and records. See docs/SPEC.md, "Vault contract spec".

use covenant_policy::{AssetId, ChainKind, CovenantError, Payment, Policy, TxMeta};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, AccountId, PanicOnDefault};

const NS_PER_24H: u64 = 86_400_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub btc: String,
    pub evm: String,
    pub sol: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub id: u64,
    pub chain: ChainKind,
    pub tx: Base64VecU8,
    pub meta: TxMeta,
    pub payments: Vec<Payment>,
    pub fee: U128,
    pub executable_at: U64,
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

/// The signature returned by the MPC signer, as recorded in docs/SPIKE.md.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MpcSignature {
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpendOutcome {
    Signed {
        id: U64,
        signatures: Vec<MpcSignature>,
    },
    Queued {
        id: U64,
        executable_at: U64,
    },
    Rejected(CovenantError),
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Addresses {
    pub btc_pubkey: String,
    pub evm_address: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendEvent {
    pub id: U64,
    pub chain: ChainKind,
    pub payments: Vec<Payment>,
    pub fee: U128,
    pub error: Option<CovenantError>,
}

/// NEP-297 events. Each logs as `EVENT_JSON:{"standard":"covenant","version":"1.0.0",...}`.
#[near(event_json(standard = "covenant"))]
pub enum CovenantEvent {
    #[event_version("1.0.0")]
    SpendProposed(SpendEvent),
    #[event_version("1.0.0")]
    SpendQueued(SpendEvent),
    #[event_version("1.0.0")]
    SpendSigned(SpendEvent),
    #[event_version("1.0.0")]
    SpendRejected(SpendEvent),
    #[event_version("1.0.0")]
    SpendVetoed(SpendEvent),
    #[event_version("1.0.0")]
    Frozen { by: AccountId },
    #[event_version("1.0.0")]
    Unfrozen { by: AccountId },
    #[event_version("1.0.0")]
    PolicyUpdated { policy_hash: String },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CovenantVault {
    owner: AccountId,
    guardian: Option<AccountId>,
    agent: AccountId,
    signer: AccountId,
    paths: Paths,
    btc_pubkey: [u8; 33],
    evm_address: [u8; 20],
    policy: Policy,
    frozen: bool,
    ledger: LookupMap<AssetId, Vec<(u64, u128)>>,
    queue: IterableMap<u64, Pending>,
    next_id: u64,
}

fn fail(error: CovenantError) -> ! {
    env::panic_str(&error.to_string())
}

fn checked_policy(policy: &Policy) {
    if let Err(reason) = policy.validate() {
        env::panic_str(reason);
    }
}

#[near]
impl CovenantVault {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        guardian: Option<AccountId>,
        agent: AccountId,
        signer: AccountId,
        paths: Paths,
        btc_pubkey: Base64VecU8,
        evm_address: [u8; 20],
        policy: Policy,
    ) -> Self {
        checked_policy(&policy);
        let btc_pubkey: [u8; 33] = btc_pubkey
            .0
            .try_into()
            .unwrap_or_else(|_| env::panic_str("btc_pubkey must be 33 bytes"));
        if btc_pubkey[0] != 0x02 && btc_pubkey[0] != 0x03 {
            env::panic_str("btc_pubkey must be compressed");
        }
        Self {
            owner,
            guardian,
            agent,
            signer,
            paths,
            btc_pubkey,
            evm_address,
            policy,
            frozen: false,
            ledger: LookupMap::new(b"l"),
            queue: IterableMap::new(b"q"),
            next_id: 0,
        }
    }

    /// Not implemented yet: refuses every call after the access and freeze checks.
    pub fn propose_spend(
        &mut self,
        chain: ChainKind,
        tx: Base64VecU8,
        meta: TxMeta,
    ) -> SpendOutcome {
        self.assert_agent();
        self.assert_not_frozen();
        let _ = (chain, tx, meta, &self.signer, &self.paths, self.next_id);
        env::panic_str("propose_spend: not implemented")
    }

    /// Not implemented yet: refuses every call after the access and freeze checks.
    pub fn execute(&mut self, id: U64) -> SpendOutcome {
        self.assert_agent();
        self.assert_not_frozen();
        let _ = id;
        env::panic_str("execute: not implemented")
    }

    /// Not implemented yet: refuses every call after the access check.
    pub fn veto(&mut self, id: U64) {
        self.assert_guardian_or_owner();
        let _ = id;
        env::panic_str("veto: not implemented")
    }

    pub fn freeze(&mut self) {
        self.assert_guardian_or_owner();
        self.frozen = true;
        CovenantEvent::Frozen {
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    pub fn unfreeze(&mut self) {
        self.assert_owner();
        self.frozen = false;
        CovenantEvent::Unfrozen {
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        checked_policy(&policy);
        let bytes = near_sdk::borsh::to_vec(&policy)
            .unwrap_or_else(|_| env::panic_str("policy serialization failed"));
        self.policy = policy;
        CovenantEvent::PolicyUpdated {
            policy_hash: hex::encode(env::sha256(&bytes)),
        }
        .emit();
    }

    pub fn get_policy(&self) -> &Policy {
        &self.policy
    }

    pub fn get_addresses(&self) -> Addresses {
        Addresses {
            btc_pubkey: hex::encode(self.btc_pubkey),
            evm_address: format!("0x{}", hex::encode(self.evm_address)),
        }
    }

    pub fn get_queue(&self) -> Vec<&Pending> {
        self.queue.values().collect()
    }

    pub fn get_spent_24h(&self, asset: AssetId) -> U128 {
        let cutoff = env::block_timestamp().saturating_sub(NS_PER_24H);
        let spent = self.ledger.get(&asset).map_or(0, |entries| {
            entries
                .iter()
                .filter(|(at, _)| *at > cutoff)
                .map(|(_, amount)| *amount)
                .sum()
        });
        U128(spent)
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen
    }
}

impl CovenantVault {
    fn assert_agent(&self) {
        if env::predecessor_account_id() != self.agent {
            fail(CovenantError::NotAgent);
        }
    }

    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            fail(CovenantError::NotOwner);
        }
    }

    fn assert_guardian_or_owner(&self) {
        let caller = env::predecessor_account_id();
        if caller != self.owner && Some(&caller) != self.guardian.as_ref() {
            fail(CovenantError::NotGuardianOrOwner);
        }
    }

    fn assert_not_frozen(&self) {
        if self.frozen {
            fail(CovenantError::Frozen);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use covenant_policy::AssetCap;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn call_as(name: &str) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account(name))
            .build());
    }

    fn policy(per_tx: u128, queue_at: u128) -> Policy {
        Policy {
            caps: vec![AssetCap {
                asset: AssetId::Btc,
                per_tx: U128(per_tx),
                per_24h: U128(per_tx * 5),
                queue_at: U128(queue_at),
            }],
            payees: vec![],
            btc_max_fee_rate: 50,
            btc_max_inputs: 3,
            evm_chain_ids: vec![84532],
            evm_max_gas_cost: U128(1_000_000_000_000_000),
            veto_delay_ns: 120_000_000_000,
        }
    }

    fn vault() -> CovenantVault {
        call_as("deployer.testnet");
        let mut btc_pubkey = vec![0x02];
        btc_pubkey.extend([7u8; 32]);
        CovenantVault::new(
            account("owner.testnet"),
            Some(account("guardian.testnet")),
            account("agent.testnet"),
            account("v1.signer-prod.testnet"),
            Paths {
                btc: "btc-vault-1".into(),
                evm: "evm-vault-1".into(),
                sol: "sol-vault-1".into(),
            },
            btc_pubkey.into(),
            [9u8; 20],
            policy(100, 50),
        )
    }

    #[test]
    fn mpc_signature_parses_a_live_response() {
        let live = r#"{
            "scheme": "Secp256k1",
            "big_r": { "affine_point": "0265c90fd8479fe510e68c39fb23e42bf30e1869e6affb2249c09820a08bb664ec" },
            "s": { "scalar": "08f7ed44a950030d0cbb3b5066a08049ded45620080af5c455617fbaec6a3878" },
            "recovery_id": 1
        }"#;
        let signature: MpcSignature = near_sdk::serde_json::from_str(live).unwrap();
        assert_eq!(signature.recovery_id, 1);
    }

    #[test]
    fn new_starts_unfrozen_with_an_empty_queue() {
        let vault = vault();
        assert!(!vault.is_frozen());
        assert!(vault.get_queue().is_empty());
        assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(0));
        assert_eq!(
            vault.get_addresses().evm_address,
            format!("0x{}", "09".repeat(20))
        );
    }

    #[test]
    #[should_panic(expected = "queue_at must not exceed per_tx")]
    fn set_policy_validates() {
        let mut vault = vault();
        call_as("owner.testnet");
        vault.set_policy(policy(100, 101));
    }

    #[test]
    #[should_panic(expected = "NotOwner")]
    fn agent_cannot_set_policy() {
        let mut vault = vault();
        call_as("agent.testnet");
        vault.set_policy(policy(100, 50));
    }

    #[test]
    #[should_panic(expected = "NotAgent")]
    fn non_agent_cannot_reach_propose() {
        let mut vault = vault();
        call_as("owner.testnet");
        vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm);
    }

    #[test]
    #[should_panic(expected = "Frozen")]
    fn freeze_blocks_the_agent() {
        let mut vault = vault();
        call_as("guardian.testnet");
        vault.freeze();
        call_as("agent.testnet");
        vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm);
    }

    #[test]
    #[should_panic(expected = "NotOwner")]
    fn guardian_cannot_unfreeze() {
        let mut vault = vault();
        call_as("guardian.testnet");
        vault.freeze();
        vault.unfreeze();
    }

    #[test]
    #[should_panic(expected = "not implemented")]
    fn unimplemented_propose_fails_closed() {
        let mut vault = vault();
        call_as("agent.testnet");
        vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm);
    }
}

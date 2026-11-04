//! The vault contract. Adapters turn a raw transaction into payments and signing hashes, the
//! policy crate decides, and this contract orchestrates: it reserves budget, queues or signs,
//! and records. See docs/SPEC.md, "Vault contract spec".

use covenant_adapter_bitcoin::BitcoinVault;
use covenant_policy::{
    AssetId, ChainKind, Charge, CovenantError, Decision, ParsedTx, Payment, Policy, TxMeta,
};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const NS_PER_24H: u64 = 86_400_000_000_000;
/// docs/SPIKE.md: the live signer needs 15 Tgas, and 8 joined calls ran at 30.
const SIGN_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const SECP256K1_DOMAIN: u32 = 0;
/// Well above a signature's JSON, which is under 300 bytes.
const MAX_SIGNATURE_LEN: usize = 1024;

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

    /// Parses, checks and signs a spend. Policy failures return `Rejected` and change nothing;
    /// auth failures and malformed bytes panic. Spends that must wait out the veto window are
    /// refused until the queue exists.
    pub fn propose_spend(
        &mut self,
        chain: ChainKind,
        tx: Base64VecU8,
        meta: TxMeta,
    ) -> PromiseOrValue<SpendOutcome> {
        self.assert_agent();
        self.assert_not_frozen();
        let parsed = match self.parse(chain, &tx.0, &meta) {
            Ok(parsed) => parsed,
            Err(CovenantError::MalformedTx) => fail(CovenantError::MalformedTx),
            Err(error) => return self.reject(chain, vec![], 0, error),
        };
        let charges = covenant_policy::charges(&parsed).unwrap_or_else(|error| fail(error));
        let decision =
            covenant_policy::check(&charges, &self.policy, |asset| self.spent_24h(asset));
        match decision {
            Ok(Decision::Sign) => {}
            Ok(Decision::Queue) => env::panic_str("propose_spend: queue not implemented"),
            Err(error) => return self.reject(chain, parsed.payments, parsed.fee, error),
        }

        let id = self.next_id;
        self.next_id += 1;
        let at = env::block_timestamp();
        for charge in &charges {
            self.reserve(charge, at);
        }
        CovenantEvent::SpendProposed(SpendEvent {
            id: U64(id),
            chain,
            payments: parsed.payments.clone(),
            fee: U128(parsed.fee),
            error: None,
        })
        .emit();
        PromiseOrValue::Promise(self.sign_all(id, chain, parsed, charges, at))
    }

    /// Runs after every `sign` in the join. A failed `sign` doesn't revert the join, so it shows up
    /// here as a failed result. See docs/SPIKE.md.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_signed(
        &mut self,
        id: U64,
        count: u64,
        chain: ChainKind,
        payments: Vec<Payment>,
        fee: U128,
        charges: Vec<Charge>,
        at: U64,
    ) -> SpendOutcome {
        let signatures: Option<Vec<MpcSignature>> = (0..count)
            .map(|index| {
                let bytes = env::promise_result_checked(index, MAX_SIGNATURE_LEN).ok()?;
                serde_json::from_slice(&bytes).ok()
            })
            .collect();
        let event = SpendEvent {
            id,
            chain,
            payments,
            fee,
            error: signatures.is_none().then_some(CovenantError::SignFailed),
        };
        match signatures {
            Some(signatures) => {
                CovenantEvent::SpendSigned(event).emit();
                SpendOutcome::Signed { id, signatures }
            }
            None => {
                // A freeze keeps the reservation, because part of the join may have been signed.
                if !self.frozen {
                    for charge in &charges {
                        self.release(charge, at.0);
                    }
                }
                CovenantEvent::SpendRejected(event).emit();
                SpendOutcome::Rejected(CovenantError::SignFailed)
            }
        }
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
        U128(self.spent_24h(&asset))
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen
    }
}

impl CovenantVault {
    fn parse(&self, chain: ChainKind, tx: &[u8], meta: &TxMeta) -> Result<ParsedTx, CovenantError> {
        match (chain, meta) {
            (ChainKind::Bitcoin, _) => {
                let vault = BitcoinVault {
                    pubkey: &self.btc_pubkey,
                };
                covenant_adapter_bitcoin::parse(tx, meta, &self.policy, &vault)
            }
            (ChainKind::Evm, TxMeta::Evm) => covenant_adapter_evm::parse(tx, &self.policy),
            (ChainKind::Evm, _) => Err(CovenantError::MalformedTx),
            (ChainKind::Solana, _) => env::panic_str("propose_spend: solana not implemented"),
        }
    }

    fn reject(
        &self,
        chain: ChainKind,
        payments: Vec<Payment>,
        fee: u128,
        error: CovenantError,
    ) -> PromiseOrValue<SpendOutcome> {
        CovenantEvent::SpendRejected(SpendEvent {
            id: U64(self.next_id),
            chain,
            payments,
            fee: U128(fee),
            error: Some(error),
        })
        .emit();
        PromiseOrValue::Value(SpendOutcome::Rejected(error))
    }

    fn sign_all(
        &self,
        id: u64,
        chain: ChainKind,
        parsed: ParsedTx,
        charges: Vec<Charge>,
        at: u64,
    ) -> Promise {
        let path = match chain {
            ChainKind::Bitcoin => &self.paths.btc,
            ChainKind::Evm => &self.paths.evm,
            ChainKind::Solana => &self.paths.sol,
        };
        let count = parsed.signing_hashes.len() as u64;
        parsed
            .signing_hashes
            .iter()
            .map(|hash| {
                let args = json!({
                    "request": {
                        "payload_v2": { "Ecdsa": hex::encode(hash) },
                        "path": path,
                        "domain_id": SECP256K1_DOMAIN,
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
                    .on_signed(
                        U64(id),
                        count,
                        chain,
                        parsed.payments,
                        U128(parsed.fee),
                        charges,
                        U64(at),
                    ),
            )
    }

    fn spent_24h(&self, asset: &AssetId) -> u128 {
        let cutoff = env::block_timestamp().saturating_sub(NS_PER_24H);
        self.ledger.get(asset).map_or(0, |entries| {
            entries
                .iter()
                .filter(|(at, _)| *at > cutoff)
                .map(|(_, amount)| *amount)
                .sum()
        })
    }

    fn reserve(&mut self, charge: &Charge, at: u64) {
        let cutoff = at.saturating_sub(NS_PER_24H);
        let entries = self.ledger.entry(charge.asset.clone()).or_default();
        entries.retain(|(entry_at, _)| *entry_at > cutoff);
        entries.push((at, charge.amount.0));
    }

    fn release(&mut self, charge: &Charge, at: u64) {
        if let Some(entries) = self.ledger.get_mut(&charge.asset) {
            let entry = (at, charge.amount.0);
            if let Some(index) = entries.iter().position(|e| *e == entry) {
                entries.remove(index);
            }
        }
    }

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
        let _ = vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm);
    }

    #[test]
    #[should_panic(expected = "Frozen")]
    fn freeze_blocks_the_agent() {
        let mut vault = vault();
        call_as("guardian.testnet");
        vault.freeze();
        call_as("agent.testnet");
        let _ = vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm);
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
    #[should_panic(expected = "MalformedTx")]
    fn malformed_tx_panics() {
        let mut vault = vault();
        call_as("agent.testnet");
        let _ = vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm);
    }

    #[test]
    #[should_panic(expected = "MalformedTx")]
    fn evm_with_bitcoin_meta_panics() {
        let mut vault = vault();
        call_as("agent.testnet");
        let meta = TxMeta::Bitcoin { prev_txs: vec![] };
        let _ = vault.propose_spend(ChainKind::Evm, vec![].into(), meta);
    }

    #[test]
    #[should_panic(expected = "solana not implemented")]
    fn solana_fails_closed() {
        let mut vault = vault();
        call_as("agent.testnet");
        let _ = vault.propose_spend(ChainKind::Solana, vec![].into(), TxMeta::Solana);
    }

    #[test]
    fn release_removes_only_its_own_reservation() {
        let mut vault = vault();
        call_as("agent.testnet");
        let charge = |amount| Charge {
            asset: AssetId::Btc,
            amount: U128(amount),
        };
        vault.reserve(&charge(30), 1);
        vault.reserve(&charge(30), 2);
        vault.reserve(&charge(40), 2);
        assert_eq!(vault.spent_24h(&AssetId::Btc), 100);
        vault.release(&charge(30), 2);
        assert_eq!(vault.spent_24h(&AssetId::Btc), 70);
        vault.release(&charge(30), 2);
        assert_eq!(vault.spent_24h(&AssetId::Btc), 70);
    }
}

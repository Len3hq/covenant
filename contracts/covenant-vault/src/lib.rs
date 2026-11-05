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
/// The vault pays for queue storage, so an agent must not be able to grow it without limit.
const MAX_QUEUE: u32 = 16;

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
    pub id: U64,
    pub chain: ChainKind,
    pub payments: Vec<Payment>,
    pub fee: U128,
    pub fee_asset: AssetId,
    pub signing_hashes: Vec<[u8; 32]>,
    pub vsize: u64,
    pub charges: Vec<Charge>,
    pub queued_at: U64,
    pub executable_at: U64,
}

impl Pending {
    fn parsed(&self) -> ParsedTx {
        ParsedTx {
            payments: self.payments.clone(),
            fee: self.fee.0,
            fee_asset: self.fee_asset.clone(),
            signing_hashes: self.signing_hashes.clone(),
            vsize: self.vsize,
        }
    }

    fn event(&self, error: Option<CovenantError>) -> SpendEvent {
        SpendEvent {
            id: self.id,
            chain: self.chain,
            payments: self.payments.clone(),
            fee: self.fee,
            error,
        }
    }
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
pub struct Roles {
    pub owner: AccountId,
    pub guardian: Option<AccountId>,
    pub agent: AccountId,
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
    #[event_version("1.0.0")]
    GuardianUpdated { guardian: Option<AccountId> },
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

    /// Parses, checks and signs or queues a spend. Policy failures return `Rejected` and change
    /// nothing; auth failures and malformed bytes panic.
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
            Err(error) => return self.reject(self.next_id, chain, vec![], 0, error),
        };
        let charges = covenant_policy::charges(&parsed).unwrap_or_else(|error| fail(error));
        let decision =
            covenant_policy::check(&charges, &self.policy, |asset| self.spent_24h(asset));
        let decision = match decision {
            Ok(decision) => decision,
            Err(error) => {
                return self.reject(self.next_id, chain, parsed.payments, parsed.fee, error)
            }
        };
        if decision == Decision::Queue && self.queue.len() >= MAX_QUEUE {
            let error = CovenantError::QueueFull;
            return self.reject(self.next_id, chain, parsed.payments, parsed.fee, error);
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
        match decision {
            Decision::Sign => {
                PromiseOrValue::Promise(self.sign_all(id, chain, parsed, charges, at))
            }
            Decision::Queue => PromiseOrValue::Value(self.enqueue(id, chain, parsed, charges, at)),
        }
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

    /// Signs a queued spend once its veto window has passed, if today's policy still allows it. A
    /// spend that fails the re-check leaves the queue and must be proposed again, with a new window.
    pub fn execute(&mut self, id: U64) -> PromiseOrValue<SpendOutcome> {
        self.assert_agent();
        self.assert_not_frozen();
        let pending = self
            .queue
            .get(&id.0)
            .cloned()
            .unwrap_or_else(|| fail(CovenantError::UnknownSpend));
        let now = env::block_timestamp();
        // A delay raised since the spend was queued applies to it too.
        let ready = pending.executable_at.0.max(
            pending
                .queued_at
                .0
                .saturating_add(self.policy.veto_delay_ns),
        );
        let parsed = pending.parsed();
        if now < ready {
            let error = CovenantError::NotYetExecutable;
            return self.reject(id.0, pending.chain, parsed.payments, parsed.fee, error);
        }

        self.queue.remove(&id.0);
        // The spend's own reservation must not count against it, and it restarts at signing time so
        // it stays on the ledger for a full 24 h after the money moves (C6).
        for charge in &pending.charges {
            self.release(charge, pending.queued_at.0);
        }
        let decision = covenant_policy::recheck_parsed(pending.chain, &parsed, &self.policy)
            .and_then(|()| {
                covenant_policy::check(&pending.charges, &self.policy, |asset| {
                    self.spent_24h(asset)
                })
            });
        if let Err(error) = decision {
            return self.reject(id.0, pending.chain, parsed.payments, parsed.fee, error);
        }
        for charge in &pending.charges {
            self.reserve(charge, now);
        }
        PromiseOrValue::Promise(self.sign_all(id.0, pending.chain, parsed, pending.charges, now))
    }

    /// Removes a queued spend and returns its budget. This works during a freeze, because a human
    /// stopping the agent may want to clear the queue before unfreezing.
    pub fn veto(&mut self, id: U64) {
        self.assert_guardian_or_owner();
        let pending = self
            .queue
            .remove(&id.0)
            .unwrap_or_else(|| fail(CovenantError::UnknownSpend));
        for charge in &pending.charges {
            self.release(charge, pending.queued_at.0);
        }
        CovenantEvent::SpendVetoed(pending.event(None)).emit();
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

    pub fn set_guardian(&mut self, guardian: Option<AccountId>) {
        self.assert_owner();
        self.guardian = guardian.clone();
        CovenantEvent::GuardianUpdated { guardian }.emit();
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

    pub fn get_roles(&self) -> Roles {
        Roles {
            owner: self.owner.clone(),
            guardian: self.guardian.clone(),
            agent: self.agent.clone(),
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

    fn enqueue(
        &mut self,
        id: u64,
        chain: ChainKind,
        parsed: ParsedTx,
        charges: Vec<Charge>,
        at: u64,
    ) -> SpendOutcome {
        let executable_at = U64(at.saturating_add(self.policy.veto_delay_ns));
        let pending = Pending {
            id: U64(id),
            chain,
            payments: parsed.payments,
            fee: U128(parsed.fee),
            fee_asset: parsed.fee_asset,
            signing_hashes: parsed.signing_hashes,
            vsize: parsed.vsize,
            charges,
            queued_at: U64(at),
            executable_at,
        };
        CovenantEvent::SpendQueued(pending.event(None)).emit();
        self.queue.insert(id, pending);
        SpendOutcome::Queued {
            id: U64(id),
            executable_at,
        }
    }

    fn reject(
        &self,
        id: u64,
        chain: ChainKind,
        payments: Vec<Payment>,
        fee: u128,
        error: CovenantError,
    ) -> PromiseOrValue<SpendOutcome> {
        CovenantEvent::SpendRejected(SpendEvent {
            id: U64(id),
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

    #[test]
    fn signing_failure_during_a_freeze_keeps_the_reservation() {
        let mut vault = vault();
        call_as("agent.testnet");
        let charge = Charge {
            asset: AssetId::Btc,
            amount: U128(30),
        };
        vault.reserve(&charge, 0);
        let spent_before = vault.ledger.get(&AssetId::Btc).cloned();
        call_as("guardian.testnet");
        vault.freeze();
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(account("vault.testnet"))
                .current_account_id(account("vault.testnet"))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Failed],
        );
        let outcome = vault.on_signed(
            U64(0),
            1,
            ChainKind::Bitcoin,
            vec![],
            U128(0),
            vec![charge],
            U64(0),
        );
        assert_eq!(outcome, SpendOutcome::Rejected(CovenantError::SignFailed));
        assert_eq!(vault.ledger.get(&AssetId::Btc).cloned(), spent_before);
    }

    mod daily_cap {
        use super::*;
        use covenant_adapter_bitcoin::{double_sha256, hash160, p2wpkh_script};
        use covenant_policy::Payee;
        use near_sdk::{PromiseResult, RuntimeFeesConfig};
        use proptest::prelude::*;

        const PER_TX: u64 = 100_000;
        const PER_24H: u64 = 300_000;
        const HOUR: u64 = NS_PER_24H / 24;
        const FEE: u64 = 1_000;
        const QUEUE_AT: u64 = 50_000;
        const SIGNATURE: &str = r#"{"scheme":"Secp256k1","big_r":{"affine_point":"02aa"},"s":{"scalar":"bb"},"recovery_id":0}"#;

        #[derive(Clone, Debug)]
        enum Step {
            Propose(u64),
            /// Settles the oldest proposal still awaiting signatures.
            Settle {
                signed: bool,
            },
            Wait(u64),
            /// Vetoes the oldest queued spend.
            Veto,
            /// Executes the oldest queued spend, whether or not its window has passed.
            Execute,
        }

        fn steps() -> impl Strategy<Value = Vec<Step>> {
            let step = prop_oneof![
                4 => (1_000u64..PER_TX - FEE).prop_map(Step::Propose),
                3 => any::<bool>().prop_map(|signed| Step::Settle { signed }),
                1 => (0u64..30).prop_map(|hours| Step::Wait(hours * HOUR)),
                1 => Just(Step::Veto),
                2 => Just(Step::Execute),
            ];
            prop::collection::vec(step, 1..40)
        }

        fn at_time(now: u64, results: Vec<PromiseResult>) {
            let caller = if results.is_empty() {
                "agent.testnet"
            } else {
                "vault.testnet"
            };
            at_time_as(caller, now, results);
        }

        fn at_time_as(caller: &str, now: u64, results: Vec<PromiseResult>) {
            testing_env!(
                VMContextBuilder::new()
                    .current_account_id(account("vault.testnet"))
                    .predecessor_account_id(account(caller))
                    .block_timestamp(now)
                    .prepaid_gas(Gas::from_tgas(300))
                    .build(),
                near_sdk::test_vm_config(),
                RuntimeFeesConfig::test(),
                Default::default(),
                results,
            );
        }

        fn payee() -> Vec<u8> {
            [vec![0x00, 0x14], vec![0xaa; 20]].concat()
        }

        fn output(amount: u64, script: &[u8]) -> Vec<u8> {
            let mut bytes = amount.to_le_bytes().to_vec();
            bytes.push(script.len() as u8);
            bytes.extend(script);
            bytes
        }

        /// A spend of one fresh coin, with no change.
        fn proposal(salt: u64, amount: u64, own: &[u8]) -> (Base64VecU8, TxMeta) {
            let mut prev = vec![2, 0, 0, 0, 1];
            prev.extend(salt.to_le_bytes());
            prev.extend([0; 28]);
            prev.push(0);
            prev.extend([0xff; 4]);
            prev.push(1);
            prev.extend(output(amount + FEE, own));
            prev.extend([0; 4]);

            let mut tx = vec![2, 0, 0, 0, 1];
            tx.extend(double_sha256(&prev));
            tx.extend([0; 4]);
            tx.push(0);
            tx.extend([0xfd, 0xff, 0xff, 0xff]);
            tx.push(1);
            tx.extend(output(amount, &payee()));
            tx.extend([0; 4]);
            let prev_txs = vec![prev.into()];
            (tx.into(), TxMeta::Bitcoin { prev_txs })
        }

        /// Starts from empty storage, because the mock keeps it across proptest cases.
        fn capped_vault() -> CovenantVault {
            near_sdk::mock::with_mocked_blockchain(|chain| {
                chain.take_storage();
            });
            let mut vault = vault();
            vault.policy.caps = vec![AssetCap {
                asset: AssetId::Btc,
                per_tx: U128(PER_TX as u128),
                per_24h: U128(PER_24H as u128),
                queue_at: U128(QUEUE_AT as u128),
            }];
            vault.policy.payees = vec![Payee {
                chain: ChainKind::Bitcoin,
                to: payee(),
                label: "supplier".into(),
            }];
            vault.policy.btc_max_fee_rate = 1_000;
            vault
        }

        struct Awaiting {
            id: u64,
            at: u64,
            amount: u128,
        }

        struct Waiting {
            id: u64,
            at: u64,
            executable_at: u64,
            amount: u128,
        }

        fn drop_entry(charged: &mut Vec<(u64, u128)>, at: u64, amount: u128) {
            let index = charged.iter().position(|e| *e == (at, amount)).unwrap();
            charged.remove(index);
        }

        fn in_window(charged: &[(u64, u128)], now: u64) -> u128 {
            charged
                .iter()
                .filter(|(at, _)| *at > now.saturating_sub(NS_PER_24H))
                .map(|(_, amount)| *amount)
                .sum()
        }

        /// C6, in time only the mock can skip: a reservation expires while its spend waits, later
        /// spends use the budget it held, and `execute` must not take the cap past its limit.
        #[test]
        fn execute_after_long_delay_respects_daily_cap() {
            const DAY: u64 = NS_PER_24H;
            let mut vault = capped_vault();
            vault.policy.caps[0].per_24h = U128(100_000);
            vault.policy.veto_delay_ns = 2 * DAY;
            let own = p2wpkh_script(&hash160(&vault.btc_pubkey));
            let spend = |vault: &mut CovenantVault, salt, amount| {
                let (tx, meta) = proposal(salt, amount, &own);
                vault.propose_spend(ChainKind::Bitcoin, tx, meta)
            };

            let mut now = DAY;
            at_time(now, vec![]);
            let queued = spend(&mut vault, 0, 59_000);
            assert!(matches!(
                queued,
                PromiseOrValue::Value(SpendOutcome::Queued { .. })
            ));
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(60_000));

            now += 2 * DAY;
            at_time(now, vec![]);
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(0));
            for salt in 1..=3 {
                assert!(matches!(
                    spend(&mut vault, salt, 29_000),
                    PromiseOrValue::Promise(_)
                ));
            }
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(90_000));
            assert!(matches!(
                vault.execute(U64(0)),
                PromiseOrValue::Value(SpendOutcome::Rejected(CovenantError::DailyCapExceeded))
            ));
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(90_000));
            assert!(vault.get_queue().is_empty());

            // Once it signs, a spend stays on the ledger for 24 h from signing, not from proposal.
            now += DAY + 1;
            at_time(now, vec![]);
            assert!(matches!(
                spend(&mut vault, 4, 59_000),
                PromiseOrValue::Value(SpendOutcome::Queued { .. })
            ));
            now += 2 * DAY;
            at_time(now, vec![]);
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(0));
            assert!(matches!(vault.execute(U64(4)), PromiseOrValue::Promise(_)));
            at_time(now + DAY - 1, vec![]);
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(60_000));
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(64))]

            /// A model charges every accepted proposal and refunds only failed or vetoed ones, apart from
            /// the vault's ledger. The two must always agree, and neither may pass the cap.
            #[test]
            fn prop_daily_cap_never_exceeded(steps in steps()) {
                let mut vault = capped_vault();
                let own = p2wpkh_script(&hash160(&vault.btc_pubkey));
                let mut now = NS_PER_24H;
                let mut charged: Vec<(u64, u128)> = Vec::new();
                let mut awaiting: Vec<Awaiting> = Vec::new();
                let mut queued: Vec<Waiting> = Vec::new();

                for (salt, step) in steps.into_iter().enumerate() {
                    match step {
                        Step::Propose(amount) => {
                            at_time(now, vec![]);
                            let (tx, meta) = proposal(salt as u64, amount, &own);
                            let charge = (amount + FEE) as u128;
                            let room = in_window(&charged, now) + charge <= PER_24H as u128;
                            let id = vault.next_id;
                            match vault.propose_spend(ChainKind::Bitcoin, tx, meta) {
                                PromiseOrValue::Promise(promise) => {
                                    let _ = promise;
                                    prop_assert!(room);
                                    prop_assert!(charge < QUEUE_AT as u128);
                                    charged.push((now, charge));
                                    awaiting.push(Awaiting { id, at: now, amount: charge });
                                }
                                PromiseOrValue::Value(SpendOutcome::Queued { executable_at, .. }) => {
                                    prop_assert!(room);
                                    prop_assert!(charge >= QUEUE_AT as u128);
                                    charged.push((now, charge));
                                    queued.push(Waiting {
                                        id,
                                        at: now,
                                        executable_at: executable_at.0,
                                        amount: charge,
                                    });
                                }
                                PromiseOrValue::Value(outcome) => {
                                    let expected = if room {
                                        prop_assert!(queued.len() >= MAX_QUEUE as usize);
                                        CovenantError::QueueFull
                                    } else {
                                        CovenantError::DailyCapExceeded
                                    };
                                    prop_assert_eq!(outcome, SpendOutcome::Rejected(expected));
                                }
                            }
                        }
                        Step::Settle { signed } => {
                            if awaiting.is_empty() {
                                continue;
                            }
                            let spend = awaiting.remove(0);
                            let result = if signed {
                                PromiseResult::Successful(SIGNATURE.as_bytes().to_vec())
                            } else {
                                PromiseResult::Failed
                            };
                            at_time(now, vec![result]);
                            let charges = vec![Charge {
                                asset: AssetId::Btc,
                                amount: U128(spend.amount),
                            }];
                            let outcome = vault.on_signed(
                                U64(spend.id),
                                1,
                                ChainKind::Bitcoin,
                                vec![],
                                U128(FEE as u128),
                                charges,
                                U64(spend.at),
                            );
                            if signed {
                                let is_signed = matches!(outcome, SpendOutcome::Signed { .. });
                                prop_assert!(is_signed);
                            } else {
                                prop_assert_eq!(
                                    outcome,
                                    SpendOutcome::Rejected(CovenantError::SignFailed)
                                );
                                drop_entry(&mut charged, spend.at, spend.amount);
                            }
                        }
                        Step::Wait(ns) => now += ns,
                        Step::Veto => {
                            if queued.is_empty() {
                                continue;
                            }
                            let spend = queued.remove(0);
                            at_time_as("owner.testnet", now, vec![]);
                            vault.veto(U64(spend.id));
                            drop_entry(&mut charged, spend.at, spend.amount);
                        }
                        Step::Execute => {
                            if queued.is_empty() {
                                continue;
                            }
                            at_time(now, vec![]);
                            let id = queued[0].id;
                            let outcome = vault.execute(U64(id));
                            if now < queued[0].executable_at {
                                let is_too_early = matches!(
                                    outcome,
                                    PromiseOrValue::Value(SpendOutcome::Rejected(
                                        CovenantError::NotYetExecutable
                                    ))
                                );
                                prop_assert!(is_too_early);
                            } else {
                                let spend = queued.remove(0);
                                drop_entry(&mut charged, spend.at, spend.amount);
                                let room =
                                    in_window(&charged, now) + spend.amount <= PER_24H as u128;
                                match outcome {
                                    PromiseOrValue::Promise(promise) => {
                                        let _ = promise;
                                        prop_assert!(room);
                                        charged.push((now, spend.amount));
                                        awaiting.push(Awaiting {
                                            id,
                                            at: now,
                                            amount: spend.amount,
                                        });
                                    }
                                    PromiseOrValue::Value(outcome) => {
                                        prop_assert!(!room);
                                        prop_assert_eq!(
                                            outcome,
                                            SpendOutcome::Rejected(CovenantError::DailyCapExceeded)
                                        );
                                    }
                                }
                            }
                        }
                    }
                    at_time(now, vec![]);
                    let spent = vault.get_spent_24h(AssetId::Btc).0;
                    prop_assert_eq!(spent, in_window(&charged, now));
                    prop_assert!(spent <= PER_24H as u128);
                }
            }
        }
    }
}

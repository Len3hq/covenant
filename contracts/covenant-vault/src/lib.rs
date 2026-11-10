//! The vault contract. Adapters turn a raw transaction into payments and signing hashes, the
//! policy crate decides, and this contract orchestrates: it reserves budget, queues or signs,
//! and records. See docs/SPEC.md, "Vault contract spec".

use covenant_adapter_bitcoin::BitcoinVault;
use covenant_adapter_tidepool::{SignedQuote, VaultAddresses};
use covenant_policy::{
    AssetCap, AssetId, ChainKind, Charge, CovenantError, Decision, ParsedTx, Payee, Payment,
    Policy, SignPayload, SwapInfo, TxMeta, UnlistedPayees,
};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const NS_PER_24H: u64 = 86_400_000_000_000;
/// docs/SPIKE.md: the live signer needs 15 Tgas, and 8 joined calls ran at 30.
const SIGN_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const SECP256K1_DOMAIN: u32 = 0;
const ED25519_DOMAIN: u32 = 1;
const ED25519_SIGNATURE_LEN: usize = 64;
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
    pub signing_payloads: Vec<SignPayload>,
    pub vsize: u64,
    pub charges: Vec<Charge>,
    /// What the spend pays unlisted payees, reserved on the unlisted ledger.
    pub unlisted: Vec<Charge>,
    pub queued_at: U64,
    pub executable_at: U64,
    /// What a swap's quote committed to, when the spend pays a swap's deposit address.
    pub swap: Option<SwapInfo>,
}

impl Pending {
    fn parsed(&self) -> ParsedTx {
        ParsedTx {
            payments: self.payments.clone(),
            fee: self.fee.0,
            fee_asset: self.fee_asset.clone(),
            signing_payloads: self.signing_payloads.clone(),
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
            swap: self.swap.clone(),
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

/// A signature from the MPC signer, in the shapes recorded in docs/SPIKE.md: secp256k1 for Bitcoin
/// and EVM, Ed25519 for Solana.
#[near(serializers = [json])]
#[serde(tag = "scheme")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MpcSignature {
    Secp256k1 {
        big_r: AffinePoint,
        s: Scalar,
        recovery_id: u8,
    },
    Ed25519 {
        signature: Vec<u8>,
    },
}

impl MpcSignature {
    fn well_formed(&self) -> bool {
        match self {
            MpcSignature::Secp256k1 { .. } => true,
            MpcSignature::Ed25519 { signature } => signature.len() == ED25519_SIGNATURE_LEN,
        }
    }
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
    /// Base58, as Solana writes it.
    pub sol_address: String,
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
    /// Present when the spend pays a swap: where the swap delivers, and its quote's terms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap: Option<SwapInfo>,
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
    sol_pubkey: [u8; 32],
    unlisted_ledger: LookupMap<AssetId, Vec<(u64, u128)>>,
    /// Correlation ids of every quote a spend has used, so none pays twice.
    used_quotes: LookupSet<String>,
}

/// A cap as stored before open payees.
#[near(serializers = [borsh])]
struct AssetCapV2 {
    asset: AssetId,
    per_tx: U128,
    per_24h: U128,
    queue_at: U128,
}

/// The policy as stored before open payees.
#[near(serializers = [borsh])]
struct PolicyV2 {
    caps: Vec<AssetCapV2>,
    payees: Vec<Payee>,
    btc_max_fee_rate: u64,
    btc_max_inputs: u8,
    evm_chain_ids: Vec<u64>,
    evm_max_gas_cost: U128,
    veto_delay_ns: u64,
    sol_max_fee: U128,
}

/// The vault's state before open payees. As with V1, `migrate_v3` only accepts an empty queue.
#[near(serializers = [borsh])]
struct VaultV2 {
    owner: AccountId,
    guardian: Option<AccountId>,
    agent: AccountId,
    signer: AccountId,
    paths: Paths,
    btc_pubkey: [u8; 33],
    evm_address: [u8; 20],
    policy: PolicyV2,
    frozen: bool,
    ledger: LookupMap<AssetId, Vec<(u64, u128)>>,
    queue: IterableMap<u64, Pending>,
    next_id: u64,
    sol_pubkey: [u8; 32],
}

/// The policy as stored before Solana support.
#[near(serializers = [borsh])]
struct PolicyV1 {
    caps: Vec<AssetCap>,
    payees: Vec<Payee>,
    btc_max_fee_rate: u64,
    btc_max_inputs: u8,
    evm_chain_ids: Vec<u64>,
    evm_max_gas_cost: U128,
    veto_delay_ns: u64,
}

/// The vault's state before Solana support. Its queue values have the old shape, so `migrate`
/// only accepts an empty queue and never reads one.
#[near(serializers = [borsh])]
struct VaultV1 {
    owner: AccountId,
    guardian: Option<AccountId>,
    agent: AccountId,
    signer: AccountId,
    paths: Paths,
    btc_pubkey: [u8; 33],
    evm_address: [u8; 20],
    policy: PolicyV1,
    frozen: bool,
    ledger: LookupMap<AssetId, Vec<(u64, u128)>>,
    queue: IterableMap<u64, Pending>,
    next_id: u64,
}

type Ledger = LookupMap<AssetId, Vec<(u64, u128)>>;

fn sum_24h(ledger: &Ledger, asset: &AssetId) -> u128 {
    let cutoff = env::block_timestamp().saturating_sub(NS_PER_24H);
    ledger.get(asset).map_or(0, |entries| {
        entries
            .iter()
            .filter(|(at, _)| *at > cutoff)
            .map(|(_, amount)| *amount)
            .sum()
    })
}

fn reserve(ledger: &mut Ledger, charge: &Charge, at: u64) {
    let cutoff = at.saturating_sub(NS_PER_24H);
    let entries = ledger.entry(charge.asset.clone()).or_default();
    entries.retain(|(entry_at, _)| *entry_at > cutoff);
    entries.push((at, charge.amount.0));
}

fn release(ledger: &mut Ledger, charge: &Charge, at: u64) {
    if let Some(entries) = ledger.get_mut(&charge.asset) {
        let entry = (at, charge.amount.0);
        if let Some(index) = entries.iter().position(|e| *e == entry) {
            entries.remove(index);
        }
    }
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
        sol_pubkey: [u8; 32],
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
            sol_pubkey,
            unlisted_ledger: LookupMap::new(b"u"),
            used_quotes: LookupSet::new(b"x"),
        }
    }

    /// Moves a vault deployed before Solana support to this code, in the same batch as the deploy.
    /// Its policy gets `sol_max_fee` of zero, so Solana stays refused until the owner sets a policy
    /// that allows it. The ledger, roles, freeze and spend ids carry over.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(sol_pubkey: [u8; 32]) -> Self {
        let old: VaultV1 =
            env::state_read().unwrap_or_else(|| env::panic_str("migrate: no state to migrate"));
        if !old.queue.is_empty() {
            env::panic_str("migrate: veto or execute every queued spend first");
        }
        let PolicyV1 {
            caps,
            payees,
            btc_max_fee_rate,
            btc_max_inputs,
            evm_chain_ids,
            evm_max_gas_cost,
            veto_delay_ns,
        } = old.policy;
        Self {
            owner: old.owner,
            guardian: old.guardian,
            agent: old.agent,
            signer: old.signer,
            paths: old.paths,
            btc_pubkey: old.btc_pubkey,
            evm_address: old.evm_address,
            policy: Policy {
                caps,
                payees,
                btc_max_fee_rate,
                btc_max_inputs,
                evm_chain_ids,
                evm_max_gas_cost,
                veto_delay_ns,
                sol_max_fee: U128(0),
                unlisted: UnlistedPayees::Refuse,
                unlisted_veto_delay_ns: veto_delay_ns,
                swap: None,
            },
            frozen: old.frozen,
            ledger: old.ledger,
            queue: old.queue,
            next_id: old.next_id,
            sol_pubkey,
            unlisted_ledger: LookupMap::new(b"u"),
            used_quotes: LookupSet::new(b"x"),
        }
    }

    /// Moves a vault deployed with Solana support but before open payees to this code, in the same
    /// batch as the deploy. Unlisted payees stay refused, and every `unlisted_per_24h` is zero, until
    /// the owner sets a policy that holds them.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v3() -> Self {
        let old: VaultV2 =
            env::state_read().unwrap_or_else(|| env::panic_str("migrate: no state to migrate"));
        if !old.queue.is_empty() {
            env::panic_str("migrate: veto or execute every queued spend first");
        }
        let PolicyV2 {
            caps,
            payees,
            btc_max_fee_rate,
            btc_max_inputs,
            evm_chain_ids,
            evm_max_gas_cost,
            veto_delay_ns,
            sol_max_fee,
        } = old.policy;
        let caps = caps
            .into_iter()
            .map(|cap| AssetCap {
                asset: cap.asset,
                per_tx: cap.per_tx,
                per_24h: cap.per_24h,
                queue_at: cap.queue_at,
                unlisted_per_24h: U128(0),
            })
            .collect();
        Self {
            owner: old.owner,
            guardian: old.guardian,
            agent: old.agent,
            signer: old.signer,
            paths: old.paths,
            btc_pubkey: old.btc_pubkey,
            evm_address: old.evm_address,
            policy: Policy {
                caps,
                payees,
                btc_max_fee_rate,
                btc_max_inputs,
                evm_chain_ids,
                evm_max_gas_cost,
                veto_delay_ns,
                sol_max_fee,
                unlisted: UnlistedPayees::Refuse,
                unlisted_veto_delay_ns: veto_delay_ns,
                swap: None,
            },
            frozen: old.frozen,
            ledger: old.ledger,
            queue: old.queue,
            next_id: old.next_id,
            sol_pubkey: old.sol_pubkey,
            unlisted_ledger: LookupMap::new(b"u"),
            used_quotes: LookupSet::new(b"x"),
        }
    }

    /// Parses, checks and signs or queues a spend. Policy failures return `Rejected` and change
    /// nothing; auth failures and malformed bytes panic.
    pub fn propose_spend(
        &mut self,
        chain: ChainKind,
        tx: Base64VecU8,
        meta: TxMeta,
        quote: Option<SignedQuote>,
    ) -> PromiseOrValue<SpendOutcome> {
        self.assert_agent();
        self.assert_not_frozen();
        let (parsed, swap) = match self.parse(chain, &tx.0, &meta, quote.as_ref()) {
            Ok(parsed) => parsed,
            Err(CovenantError::MalformedTx) => fail(CovenantError::MalformedTx),
            Err(error) => return self.reject(self.next_id, chain, vec![], 0, error),
        };
        if let Some(info) = &swap {
            if self.used_quotes.contains(&info.correlation_id) {
                let error = CovenantError::QuoteReused;
                return self.reject(self.next_id, chain, parsed.payments, parsed.fee, error);
            }
        }
        let charges = covenant_policy::charges(&parsed).unwrap_or_else(|error| fail(error));
        let unlisted = self
            .unlisted_of(chain, &parsed, swap.as_ref())
            .unwrap_or_else(|error| fail(error));
        let decision = self.decide(&charges, &unlisted);
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
        let at = env::block_timestamp();
        if let (Decision::Queue, Some(info)) = (decision, &swap) {
            // The deposit must still confirm before the quote's deadline once the window ends.
            let ready = at.saturating_add(self.policy.delay_for(!unlisted.is_empty()));
            if ready.saturating_add(self.deposit_window()) > info.deadline_ns.0 {
                let error = CovenantError::QuoteExpiresInQueue;
                return self.reject(self.next_id, chain, parsed.payments, parsed.fee, error);
            }
        }

        let id = self.next_id;
        self.next_id += 1;
        if let Some(info) = &swap {
            self.used_quotes.insert(info.correlation_id.clone());
        }
        self.reserve_all(&charges, &unlisted, at);
        CovenantEvent::SpendProposed(SpendEvent {
            id: U64(id),
            chain,
            payments: parsed.payments.clone(),
            fee: U128(parsed.fee),
            error: None,
            swap: swap.clone(),
        })
        .emit();
        match decision {
            Decision::Sign => PromiseOrValue::Promise(
                self.sign_all(id, chain, parsed, charges, unlisted, swap, at),
            ),
            Decision::Queue => {
                PromiseOrValue::Value(self.enqueue(id, chain, parsed, charges, unlisted, swap, at))
            }
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
        unlisted: Vec<Charge>,
        swap: Option<SwapInfo>,
        at: U64,
    ) -> SpendOutcome {
        let signatures: Option<Vec<MpcSignature>> = (0..count)
            .map(|index| {
                let bytes = env::promise_result_checked(index, MAX_SIGNATURE_LEN).ok()?;
                let signature: MpcSignature = serde_json::from_slice(&bytes).ok()?;
                signature.well_formed().then_some(signature)
            })
            .collect();
        let event = SpendEvent {
            id,
            chain,
            payments,
            fee,
            error: signatures.is_none().then_some(CovenantError::SignFailed),
            swap,
        };
        match signatures {
            Some(signatures) => {
                CovenantEvent::SpendSigned(event).emit();
                SpendOutcome::Signed { id, signatures }
            }
            None => {
                // A freeze keeps the reservation, because part of the join may have been signed.
                if !self.frozen {
                    self.release_all(&charges, &unlisted, at.0);
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
        let parsed = pending.parsed();
        // Today's payee list decides which payments are unlisted, so a payee removed since the
        // spend was queued gets the unlisted window and cap too.
        let unlisted = self
            .unlisted_of(pending.chain, &parsed, pending.swap.as_ref())
            .unwrap_or_else(|error| fail(error));
        // A delay raised since the spend was queued applies to it too.
        let delay = self.policy.delay_for(!unlisted.is_empty());
        let ready = pending
            .executable_at
            .0
            .max(pending.queued_at.0.saturating_add(delay));
        if now < ready {
            let error = CovenantError::NotYetExecutable;
            return self.reject(id.0, pending.chain, parsed.payments, parsed.fee, error);
        }

        self.queue.remove(&id.0);
        // The spend's own reservation must not count against it, and it restarts at signing time so
        // it stays on the ledger for a full 24 h after the money moves (C6).
        self.release_all(&pending.charges, &pending.unlisted, pending.queued_at.0);
        let recheck = match &pending.swap {
            None => covenant_policy::recheck_parsed(pending.chain, &parsed, &self.policy),
            Some(info) => self.recheck_swap(pending.chain, &parsed, info, now),
        };
        let decision = recheck.and_then(|()| self.decide(&pending.charges, &unlisted));
        if let Err(error) = decision {
            return self.reject(id.0, pending.chain, parsed.payments, parsed.fee, error);
        }
        self.reserve_all(&pending.charges, &unlisted, now);
        PromiseOrValue::Promise(self.sign_all(
            id.0,
            pending.chain,
            parsed,
            pending.charges,
            unlisted,
            pending.swap,
            now,
        ))
    }

    /// Removes a queued spend and returns its budget. This works during a freeze, because a human
    /// stopping the agent may want to clear the queue before unfreezing.
    pub fn veto(&mut self, id: U64) {
        self.assert_guardian_or_owner();
        let pending = self
            .queue
            .remove(&id.0)
            .unwrap_or_else(|| fail(CovenantError::UnknownSpend));
        self.release_all(&pending.charges, &pending.unlisted, pending.queued_at.0);
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
            sol_address: near_sdk::bs58::encode(self.sol_pubkey).into_string(),
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

    /// Whether a quote's correlation id was already used by a spend.
    pub fn is_quote_used(&self, correlation_id: String) -> bool {
        self.used_quotes.contains(&correlation_id)
    }

    /// What unlisted payees received in an asset over the last 24 h, reservations included.
    pub fn get_unlisted_spent_24h(&self, asset: AssetId) -> U128 {
        U128(sum_24h(&self.unlisted_ledger, &asset))
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen
    }
}

impl CovenantVault {
    /// Parses a spend, and with a quote checks that it pays exactly the quote's deposit and nothing
    /// else. The adapter then sees a policy whose only payee is that deposit address, so change and
    /// every other rule are checked as usual and any other output is refused.
    fn parse(
        &self,
        chain: ChainKind,
        tx: &[u8],
        meta: &TxMeta,
        quote: Option<&SignedQuote>,
    ) -> Result<(ParsedTx, Option<SwapInfo>), CovenantError> {
        let Some(quote) = quote else {
            return Ok((self.parse_under(chain, tx, meta, &self.policy)?, None));
        };
        let swap = self
            .policy
            .swap
            .as_ref()
            .ok_or(CovenantError::SwapsDisabled)?;
        let btc_script = covenant_adapter_bitcoin::p2wpkh_script(
            &covenant_adapter_bitcoin::hash160(&self.btc_pubkey),
        );
        let vault = VaultAddresses {
            btc_script: &btc_script,
            evm: &self.evm_address,
            sol: &self.sol_pubkey,
        };
        let plan =
            covenant_adapter_tidepool::verify(quote, chain, swap, &vault, env::block_timestamp())?;
        let mut deposit_only = self.policy.clone();
        deposit_only.unlisted = UnlistedPayees::Refuse;
        deposit_only.payees = vec![Payee {
            chain,
            to: plan.deposit_to.clone(),
            label: "swap deposit".into(),
        }];
        let parsed = self.parse_under(chain, tx, meta, &deposit_only)?;
        let exact = match parsed.payments.as_slice() {
            [payment] => {
                payment.to == plan.deposit_to
                    && payment.amount.0 == plan.amount_in
                    && payment.asset == plan.origin
            }
            _ => false,
        };
        if !exact {
            return Err(CovenantError::QuoteMismatch);
        }
        Ok((parsed, Some(plan.info)))
    }

    fn parse_under(
        &self,
        chain: ChainKind,
        tx: &[u8],
        meta: &TxMeta,
        policy: &Policy,
    ) -> Result<ParsedTx, CovenantError> {
        match (chain, meta) {
            (ChainKind::Bitcoin, _) => {
                let vault = BitcoinVault {
                    pubkey: &self.btc_pubkey,
                };
                covenant_adapter_bitcoin::parse(tx, meta, policy, &vault)
            }
            (ChainKind::Evm, TxMeta::Evm) => covenant_adapter_evm::parse(tx, policy),
            (ChainKind::Evm, _) => Err(CovenantError::MalformedTx),
            (ChainKind::Solana, TxMeta::Solana) => {
                covenant_adapter_solana::parse(tx, policy, &self.sol_pubkey)
            }
            (ChainKind::Solana, _) => Err(CovenantError::MalformedTx),
        }
    }

    /// What a spend pays unlisted payees. A swap's payee is its final recipient, which is listed
    /// only when the swap section lists it for that destination asset.
    fn unlisted_of(
        &self,
        chain: ChainKind,
        parsed: &ParsedTx,
        swap: Option<&SwapInfo>,
    ) -> Result<Vec<Charge>, CovenantError> {
        let Some(info) = swap else {
            return covenant_policy::unlisted_charges(chain, parsed, &self.policy);
        };
        let listed = self
            .policy
            .swap
            .as_ref()
            .is_some_and(|rules| rules.is_listed(info));
        if listed {
            return Ok(vec![]);
        }
        Ok(parsed
            .payments
            .iter()
            .map(|payment| Charge {
                asset: payment.asset.clone(),
                amount: payment.amount,
            })
            .collect())
    }

    /// The swap rules that today's policy may have changed since a swap was queued.
    fn recheck_swap(
        &self,
        chain: ChainKind,
        parsed: &ParsedTx,
        info: &SwapInfo,
        now: u64,
    ) -> Result<(), CovenantError> {
        let rules = self
            .policy
            .swap
            .as_ref()
            .ok_or(CovenantError::SwapsDisabled)?;
        let origins_listed = parsed
            .payments
            .iter()
            .all(|payment| rules.origins.iter().any(|o| o.asset == payment.asset));
        if !origins_listed || !rules.destinations.contains(&info.destination_asset) {
            return Err(CovenantError::SwapAssetNotAllowed);
        }
        if now.saturating_add(rules.min_deposit_window_ns) > info.deadline_ns.0 {
            return Err(CovenantError::QuoteExpired);
        }
        covenant_policy::recheck_fees(chain, parsed, &self.policy)
    }

    fn deposit_window(&self) -> u64 {
        self.policy
            .swap
            .as_ref()
            .map_or(0, |rules| rules.min_deposit_window_ns)
    }

    #[allow(clippy::too_many_arguments)]
    fn enqueue(
        &mut self,
        id: u64,
        chain: ChainKind,
        parsed: ParsedTx,
        charges: Vec<Charge>,
        unlisted: Vec<Charge>,
        swap: Option<SwapInfo>,
        at: u64,
    ) -> SpendOutcome {
        let delay = self.policy.delay_for(!unlisted.is_empty());
        let executable_at = U64(at.saturating_add(delay));
        let pending = Pending {
            id: U64(id),
            chain,
            payments: parsed.payments,
            fee: U128(parsed.fee),
            fee_asset: parsed.fee_asset,
            signing_payloads: parsed.signing_payloads,
            vsize: parsed.vsize,
            charges,
            unlisted,
            queued_at: U64(at),
            executable_at,
            swap,
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
            swap: None,
        })
        .emit();
        PromiseOrValue::Value(SpendOutcome::Rejected(error))
    }

    #[allow(clippy::too_many_arguments)]
    fn sign_all(
        &self,
        id: u64,
        chain: ChainKind,
        parsed: ParsedTx,
        charges: Vec<Charge>,
        unlisted: Vec<Charge>,
        swap: Option<SwapInfo>,
        at: u64,
    ) -> Promise {
        let path = match chain {
            ChainKind::Bitcoin => &self.paths.btc,
            ChainKind::Evm => &self.paths.evm,
            ChainKind::Solana => &self.paths.sol,
        };
        let count = parsed.signing_payloads.len() as u64;
        parsed
            .signing_payloads
            .iter()
            .map(|payload| {
                let (payload, domain_id) = match payload {
                    SignPayload::Ecdsa(hash) => {
                        (json!({ "Ecdsa": hex::encode(hash) }), SECP256K1_DOMAIN)
                    }
                    SignPayload::Eddsa(message) => {
                        (json!({ "Eddsa": hex::encode(&message.0) }), ED25519_DOMAIN)
                    }
                };
                let args = json!({
                    "request": {
                        "payload_v2": payload,
                        "path": path,
                        "domain_id": domain_id,
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
                        unlisted,
                        swap,
                        U64(at),
                    ),
            )
    }

    fn spent_24h(&self, asset: &AssetId) -> u128 {
        sum_24h(&self.ledger, asset)
    }

    /// Both caps must pass; any unlisted payment holds the spend.
    fn decide(&self, charges: &[Charge], unlisted: &[Charge]) -> Result<Decision, CovenantError> {
        let main = covenant_policy::check(charges, &self.policy, |asset| self.spent_24h(asset))?;
        let open = covenant_policy::check_unlisted(unlisted, &self.policy, |asset| {
            sum_24h(&self.unlisted_ledger, asset)
        })?;
        Ok(if main == Decision::Queue || open == Decision::Queue {
            Decision::Queue
        } else {
            Decision::Sign
        })
    }

    fn reserve_all(&mut self, charges: &[Charge], unlisted: &[Charge], at: u64) {
        for charge in charges {
            reserve(&mut self.ledger, charge, at);
        }
        for charge in unlisted {
            reserve(&mut self.unlisted_ledger, charge, at);
        }
    }

    fn release_all(&mut self, charges: &[Charge], unlisted: &[Charge], at: u64) {
        for charge in charges {
            release(&mut self.ledger, charge, at);
        }
        for charge in unlisted {
            release(&mut self.unlisted_ledger, charge, at);
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
                unlisted_per_24h: U128(0),
            }],
            payees: vec![],
            btc_max_fee_rate: 50,
            btc_max_inputs: 3,
            evm_chain_ids: vec![84532],
            evm_max_gas_cost: U128(1_000_000_000_000_000),
            veto_delay_ns: 120_000_000_000,
            sol_max_fee: U128(0),
            unlisted: UnlistedPayees::Refuse,
            unlisted_veto_delay_ns: 0,
            swap: None,
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
            [5u8; 32],
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
        assert!(matches!(
            signature,
            MpcSignature::Secp256k1 { recovery_id: 1, .. }
        ));
        assert_eq!(
            near_sdk::serde_json::to_value(&signature).unwrap()["scheme"],
            "Secp256k1"
        );
    }

    /// From the Ed25519 spike on 10 Nov, BeX39ENFf3Ud1E95eoBqZAj1fo3U5F7TCpLD7D1wDms2.
    #[test]
    fn mpc_signature_parses_a_live_ed25519_response() {
        let live = r#"{"scheme":"Ed25519","signature":[97,251,183,179,192,76,246,136,162,16,72,121,244,115,181,19,27,184,113,154,193,37,226,149,57,95,40,113,74,164,146,225,209,182,8,45,63,199,220,120,165,136,222,244,151,216,126,242,66,132,195,38,207,254,231,28,238,197,202,34,193,236,87,1]}"#;
        let signature: MpcSignature = near_sdk::serde_json::from_str(live).unwrap();
        assert!(signature.well_formed());
        let short: MpcSignature =
            near_sdk::serde_json::from_str(r#"{"scheme":"Ed25519","signature":[1,2,3]}"#).unwrap();
        assert!(!short.well_formed());
    }

    #[test]
    fn addresses_include_the_solana_key_in_base58() {
        let addresses = vault().get_addresses();
        assert_eq!(
            addresses.sol_address,
            near_sdk::bs58::encode([5u8; 32]).into_string()
        );
    }

    #[test]
    fn migrate_keeps_state_and_refuses_solana_until_the_owner_allows_it() {
        call_as("vault.testnet");
        let mut queue: IterableMap<u64, Pending> = IterableMap::new(b"q");
        queue.flush();
        let mut ledger = LookupMap::new(b"l");
        ledger.insert(AssetId::Btc, vec![(1u64, 700u128)]);
        ledger.flush();
        let old = VaultV1 {
            owner: account("owner.testnet"),
            guardian: None,
            agent: account("agent.testnet"),
            signer: account("v1.signer-prod.testnet"),
            paths: Paths {
                btc: "btc-vault-1".into(),
                evm: "evm-vault-1".into(),
                sol: "sol-vault-1".into(),
            },
            btc_pubkey: [2; 33],
            evm_address: [9; 20],
            policy: PolicyV1 {
                caps: policy(100, 50).caps,
                payees: vec![],
                btc_max_fee_rate: 50,
                btc_max_inputs: 3,
                evm_chain_ids: vec![84532],
                evm_max_gas_cost: U128(1),
                veto_delay_ns: 7,
            },
            frozen: true,
            ledger,
            queue,
            next_id: 42,
        };
        env::state_write(&old);
        let vault = CovenantVault::migrate([5; 32]);
        assert_eq!(vault.next_id, 42);
        assert!(vault.is_frozen());
        assert_eq!(vault.get_policy().veto_delay_ns, 7);
        assert_eq!(vault.get_policy().sol_max_fee, U128(0));
        assert_eq!(vault.get_roles().owner, account("owner.testnet"));
        assert_eq!(
            vault.ledger.get(&AssetId::Btc).cloned(),
            Some(vec![(1, 700)])
        );
        assert_eq!(vault.sol_pubkey, [5; 32]);
    }

    #[test]
    fn migrate_v3_keeps_state_and_refuses_unlisted_payees() {
        call_as("vault.testnet");
        let mut queue: IterableMap<u64, Pending> = IterableMap::new(b"q");
        queue.flush();
        let mut ledger = LookupMap::new(b"l");
        ledger.insert(AssetId::Btc, vec![(1u64, 700u128)]);
        ledger.flush();
        let old = VaultV2 {
            owner: account("owner.testnet"),
            guardian: Some(account("guardian.testnet")),
            agent: account("agent.testnet"),
            signer: account("v1.signer-prod.testnet"),
            paths: Paths {
                btc: "btc-vault-1".into(),
                evm: "evm-vault-1".into(),
                sol: "sol-vault-1".into(),
            },
            btc_pubkey: [2; 33],
            evm_address: [9; 20],
            policy: PolicyV2 {
                caps: vec![AssetCapV2 {
                    asset: AssetId::Btc,
                    per_tx: U128(100),
                    per_24h: U128(500),
                    queue_at: U128(50),
                }],
                payees: vec![],
                btc_max_fee_rate: 50,
                btc_max_inputs: 3,
                evm_chain_ids: vec![84532],
                evm_max_gas_cost: U128(1),
                veto_delay_ns: 7,
                sol_max_fee: U128(9),
            },
            frozen: true,
            ledger,
            queue,
            next_id: 42,
            sol_pubkey: [5; 32],
        };
        env::state_write(&old);
        let vault = CovenantVault::migrate_v3();
        let policy = vault.get_policy();
        assert_eq!(policy.unlisted, UnlistedPayees::Refuse);
        assert_eq!(policy.unlisted_veto_delay_ns, 7);
        assert_eq!(policy.caps[0].unlisted_per_24h, U128(0));
        assert_eq!(policy.caps[0].queue_at, U128(50));
        assert_eq!(policy.sol_max_fee, U128(9));
        assert_eq!(vault.next_id, 42);
        assert!(vault.is_frozen());
        assert_eq!(vault.sol_pubkey, [5; 32]);
        assert_eq!(
            vault.ledger.get(&AssetId::Btc).cloned(),
            Some(vec![(1, 700)])
        );
        assert_eq!(vault.get_unlisted_spent_24h(AssetId::Btc), U128(0));
    }

    mod unlisted {
        use super::*;

        const START: u64 = 1_000_000_000_000;
        const LISTED_DELAY: u64 = 120_000_000_000;
        const UNLISTED_DELAY: u64 = 600_000_000_000;

        fn at(name: &str, now: u64) {
            testing_env!(VMContextBuilder::new()
                .predecessor_account_id(account(name))
                .block_timestamp(now)
                .build());
        }

        fn open_vault() -> CovenantVault {
            let mut vault = vault();
            vault.policy.caps[0].unlisted_per_24h = U128(200);
            vault.policy.unlisted = UnlistedPayees::Hold;
            vault.policy.unlisted_veto_delay_ns = UNLISTED_DELAY;
            vault
        }

        fn stranger_spend() -> ParsedTx {
            ParsedTx {
                payments: vec![Payment {
                    asset: AssetId::Btc,
                    to: vec![0xbb; 22],
                    amount: U128(10),
                }],
                fee: 1,
                fee_asset: AssetId::Btc,
                signing_payloads: vec![SignPayload::Ecdsa([0; 32])],
                vsize: 100,
            }
        }

        /// Queues a small spend to an unlisted payee the way `propose_spend` does.
        fn hold(vault: &mut CovenantVault) -> SpendOutcome {
            let parsed = stranger_spend();
            let charges = covenant_policy::charges(&parsed).unwrap();
            let unlisted =
                covenant_policy::unlisted_charges(ChainKind::Bitcoin, &parsed, &vault.policy)
                    .unwrap();
            assert_eq!(vault.decide(&charges, &unlisted), Ok(Decision::Queue));
            vault.reserve_all(&charges, &unlisted, START);
            vault.enqueue(
                0,
                ChainKind::Bitcoin,
                parsed,
                charges,
                unlisted,
                None,
                START,
            )
        }

        #[test]
        fn small_unlisted_spend_waits_the_unlisted_window() {
            at("agent.testnet", START);
            let mut vault = open_vault();
            assert_eq!(
                hold(&mut vault),
                SpendOutcome::Queued {
                    id: U64(0),
                    executable_at: U64(START + UNLISTED_DELAY),
                }
            );
            assert_eq!(vault.get_unlisted_spent_24h(AssetId::Btc), U128(10));
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(11));
        }

        #[test]
        fn execute_after_the_listed_window_is_still_too_early() {
            at("agent.testnet", START);
            let mut vault = open_vault();
            hold(&mut vault);
            at("agent.testnet", START + LISTED_DELAY + 1);
            let outcome = vault.execute(U64(0));
            assert!(matches!(
                outcome,
                PromiseOrValue::Value(SpendOutcome::Rejected(CovenantError::NotYetExecutable))
            ));
            assert_eq!(vault.get_queue().len(), 1);
        }

        #[test]
        fn veto_returns_both_budgets() {
            at("agent.testnet", START);
            let mut vault = open_vault();
            hold(&mut vault);
            at("owner.testnet", START + 1);
            vault.veto(U64(0));
            assert!(vault.get_queue().is_empty());
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(0));
            assert_eq!(vault.get_unlisted_spent_24h(AssetId::Btc), U128(0));
        }

        #[test]
        fn switching_back_to_refuse_blocks_a_held_spend_at_execute() {
            at("agent.testnet", START);
            let mut vault = open_vault();
            hold(&mut vault);
            vault.policy.unlisted = UnlistedPayees::Refuse;
            at("agent.testnet", START + UNLISTED_DELAY);
            let outcome = vault.execute(U64(0));
            assert!(matches!(
                outcome,
                PromiseOrValue::Value(SpendOutcome::Rejected(CovenantError::OutputNotWhitelisted))
            ));
            assert_eq!(vault.get_spent_24h(AssetId::Btc), U128(0));
            assert_eq!(vault.get_unlisted_spent_24h(AssetId::Btc), U128(0));
        }

        #[test]
        fn unlisted_daily_cap_is_enforced_across_spends() {
            at("agent.testnet", START);
            let mut vault = open_vault();
            reserve(
                &mut vault.unlisted_ledger,
                &Charge {
                    asset: AssetId::Btc,
                    amount: U128(195),
                },
                START,
            );
            let parsed = stranger_spend();
            let charges = covenant_policy::charges(&parsed).unwrap();
            let unlisted =
                covenant_policy::unlisted_charges(ChainKind::Bitcoin, &parsed, &vault.policy)
                    .unwrap();
            assert_eq!(
                vault.decide(&charges, &unlisted),
                Err(CovenantError::UnlistedCapExceeded)
            );
        }
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
        let _ = vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm, None);
    }

    #[test]
    #[should_panic(expected = "Frozen")]
    fn freeze_blocks_the_agent() {
        let mut vault = vault();
        call_as("guardian.testnet");
        vault.freeze();
        call_as("agent.testnet");
        let _ = vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm, None);
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
        let _ = vault.propose_spend(ChainKind::Evm, vec![].into(), TxMeta::Evm, None);
    }

    #[test]
    #[should_panic(expected = "MalformedTx")]
    fn evm_with_bitcoin_meta_panics() {
        let mut vault = vault();
        call_as("agent.testnet");
        let meta = TxMeta::Bitcoin { prev_txs: vec![] };
        let _ = vault.propose_spend(ChainKind::Evm, vec![].into(), meta, None);
    }

    #[test]
    #[should_panic(expected = "MalformedTx")]
    fn solana_garbage_panics() {
        let mut vault = vault();
        call_as("agent.testnet");
        let _ = vault.propose_spend(ChainKind::Solana, vec![].into(), TxMeta::Solana, None);
    }

    #[test]
    #[should_panic(expected = "MalformedTx")]
    fn solana_with_evm_meta_panics() {
        let mut vault = vault();
        call_as("agent.testnet");
        let _ = vault.propose_spend(ChainKind::Solana, vec![].into(), TxMeta::Evm, None);
    }

    #[test]
    fn release_removes_only_its_own_reservation() {
        let mut vault = vault();
        call_as("agent.testnet");
        let charge = |amount| Charge {
            asset: AssetId::Btc,
            amount: U128(amount),
        };
        reserve(&mut vault.ledger, &charge(30), 1);
        reserve(&mut vault.ledger, &charge(30), 2);
        reserve(&mut vault.ledger, &charge(40), 2);
        assert_eq!(vault.spent_24h(&AssetId::Btc), 100);
        release(&mut vault.ledger, &charge(30), 2);
        assert_eq!(vault.spent_24h(&AssetId::Btc), 70);
        release(&mut vault.ledger, &charge(30), 2);
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
        reserve(&mut vault.ledger, &charge, 0);
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
            vec![],
            None,
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
                unlisted_per_24h: U128(0),
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
                vault.propose_spend(ChainKind::Bitcoin, tx, meta, None)
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
                            match vault.propose_spend(ChainKind::Bitcoin, tx, meta, None) {
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
                                vec![],
                                None,
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

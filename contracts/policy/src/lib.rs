//! Core types shared by the vault and the chain adapters, plus the pure policy checks.
//!
//! `near-sdk` is used here only for serialization and JSON types. Nothing in this crate reads
//! chain state, so every rule stays unit-testable.
//!
//! Amounts use `U128` and timestamps `U64` wherever they cross the JSON boundary, because JS
//! clients lose precision on bare integers above 2^53.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::near;
use std::fmt;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChainKind {
    Bitcoin,
    Evm,
    Solana,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AssetId {
    Btc,
    EvmNative { chain_id: u64 },
    Erc20 { chain_id: u64, token: [u8; 20] },
    Sol,
    Spl { mint: [u8; 32] },
}

/// `to` is scriptPubKey bytes (Bitcoin), a 20-byte address (EVM) or a 32-byte pubkey (Solana).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub asset: AssetId,
    pub to: Vec<u8>,
    pub amount: U128,
}

/// What the MPC signer is asked to sign. Bitcoin and EVM sign a 32-byte hash the adapter computed;
/// Solana's Ed25519 signs the whole message the adapter checked, so nothing else can be signed in
/// its place.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignPayload {
    Ecdsa([u8; 32]),
    Eddsa(Base64VecU8),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedTx {
    /// External outputs only; Bitcoin change is removed.
    pub payments: Vec<Payment>,
    /// Sats, max wei, or max lamports.
    pub fee: u128,
    /// The asset the fee is paid in, which for an ERC-20 spend differs from the payment's.
    pub fee_asset: AssetId,
    /// One per Bitcoin input; one for EVM and Solana.
    pub signing_payloads: Vec<SignPayload>,
    /// Bitcoin virtual size, which the fee-rate cap needs. Zero on EVM.
    pub vsize: u64,
}

/// What one spend takes from an asset's caps.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Charge {
    pub asset: AssetId,
    pub amount: U128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Sign,
    Queue,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetCap {
    pub asset: AssetId,
    pub per_tx: U128,
    pub per_24h: U128,
    pub queue_at: U128,
    /// The most that payees not on the list may receive in this asset in a rolling 24 h. Zero, the
    /// default, refuses them this asset even when the policy holds unlisted payees.
    #[serde(default)]
    pub unlisted_per_24h: U128,
}

/// A Tidepool asset id the vault may pay from, and the asset it is to the caps.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapOrigin {
    /// For example `nep141:btc.tp-omft.testnet`.
    pub asset_id: String,
    pub asset: AssetId,
}

/// A recipient of swapped funds that skips the unlisted rules, like a `Payee`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapPayee {
    /// For example `nep141:sol.tp-omft.testnet`.
    pub destination_asset: String,
    pub recipient: String,
    pub label: String,
}

/// Cross-chain payments through a 1Click-style swap service, Tidepool on testnet.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapPolicy {
    /// The Ed25519 key that signs the service's quotes. The owner rotates it with `set_policy`.
    pub maker_key: [u8; 32],
    /// The assets the vault may swap from. Anything else is `SwapAssetNotAllowed`.
    pub origins: Vec<SwapOrigin>,
    /// The asset ids a swap may deliver. Empty refuses every swap.
    pub destinations: Vec<String>,
    pub payees: Vec<SwapPayee>,
    pub max_slippage_bps: u32,
    /// How long a quote must stay open after signing, so the deposit confirms before its deadline.
    pub min_deposit_window_ns: u64,
}

impl SwapPolicy {
    pub fn is_listed(&self, swap: &SwapInfo) -> bool {
        self.payees.iter().any(|payee| {
            payee.destination_asset == swap.destination_asset
                && same_recipient(&payee.recipient, &swap.recipient)
        })
    }
}

/// EVM addresses compare without their checksum case; every other format is case-sensitive.
fn same_recipient(a: &str, b: &str) -> bool {
    if a.starts_with("0x") && b.starts_with("0x") {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// What a signed quote committed the swap to, kept with a queued spend and in its events.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapInfo {
    pub correlation_id: String,
    pub deposit_address: String,
    pub destination_asset: String,
    pub recipient: String,
    pub min_amount_out: U128,
    pub deadline_ns: near_sdk::json_types::U64,
}

/// What happens to a payment whose recipient isn't on the payee list.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UnlistedPayees {
    /// Refused with `OutputNotWhitelisted`.
    #[default]
    Refuse,
    /// Always held for `unlisted_veto_delay_ns`, whatever the amount, within `unlisted_per_24h`.
    Hold,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payee {
    pub chain: ChainKind,
    pub to: Vec<u8>,
    pub label: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// An asset with no cap is refused.
    pub caps: Vec<AssetCap>,
    pub payees: Vec<Payee>,
    /// sat/vB.
    pub btc_max_fee_rate: u64,
    /// Set from the gas benchmark; starts at 3.
    pub btc_max_inputs: u8,
    /// For example `[84532]`, Base Sepolia.
    pub evm_chain_ids: Vec<u64>,
    /// Wei: `gas_limit * max_fee_per_gas`.
    pub evm_max_gas_cost: U128,
    /// Demo: 120 s. Real: 24 h.
    pub veto_delay_ns: u64,
    /// Lamports: the base fee plus the most the priority fee can cost. A policy written before
    /// Solana support leaves it out, and zero refuses every Solana spend.
    #[serde(default)]
    pub sol_max_fee: U128,
    /// A policy written before open payees leaves this out and keeps refusing unlisted payees.
    #[serde(default)]
    pub unlisted: UnlistedPayees,
    /// How long a spend to an unlisted payee waits. At least `veto_delay_ns`.
    #[serde(default)]
    pub unlisted_veto_delay_ns: u64,
    /// `None`, the default, refuses every swap with `SwapsDisabled`.
    #[serde(default)]
    pub swap: Option<SwapPolicy>,
}

impl Policy {
    /// Checks the rules `new` and `set_policy` enforce: every cap is above zero, and a spend can
    /// reach the queue threshold without first exceeding its per-tx cap.
    pub fn validate(&self) -> Result<(), &'static str> {
        for cap in &self.caps {
            if cap.per_tx.0 == 0 || cap.per_24h.0 == 0 || cap.queue_at.0 == 0 {
                return Err("every cap must be above zero");
            }
            if cap.queue_at.0 > cap.per_tx.0 {
                return Err("queue_at must not exceed per_tx");
            }
            if cap.unlisted_per_24h.0 > cap.per_24h.0 {
                return Err("unlisted_per_24h must not exceed per_24h");
            }
        }
        if self.unlisted == UnlistedPayees::Hold && self.unlisted_veto_delay_ns < self.veto_delay_ns
        {
            return Err("unlisted_veto_delay_ns must be at least veto_delay_ns");
        }
        Ok(())
    }

    pub fn is_listed(&self, chain: ChainKind, to: &[u8]) -> bool {
        self.payees
            .iter()
            .any(|payee| payee.chain == chain && payee.to == to)
    }

    /// Whether an adapter may accept a payment to `to`. An unlisted payee passes only when the
    /// policy holds unlisted payees, and `check_unlisted` then decides how much and how long.
    pub fn allows_payee(&self, chain: ChainKind, to: &[u8]) -> bool {
        self.unlisted == UnlistedPayees::Hold || self.is_listed(chain, to)
    }

    /// The veto window for a spend, which is the longer one when any payee is unlisted.
    pub fn delay_for(&self, holds_unlisted: bool) -> u64 {
        if holds_unlisted {
            self.veto_delay_ns.max(self.unlisted_veto_delay_ns)
        } else {
            self.veto_delay_ns
        }
    }
}

/// What the raw transaction can't prove by itself.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TxMeta {
    /// The full previous transaction for each input, in non-witness serialization.
    Bitcoin {
        prev_txs: Vec<Base64VecU8>,
    },
    Evm,
    Solana,
}

/// Variant names are used verbatim in tests, the README and the video.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CovenantError {
    NotAgent,
    NotOwner,
    NotGuardianOrOwner,
    Frozen,
    MalformedTx,
    UnsupportedScript,
    TooManyInputs,
    PrevTxMismatch,
    InputNotOwned,
    OutputNotWhitelisted,
    ChangeNotToVault,
    FeeTooHigh,
    WrongChainId,
    CalldataNotAllowed,
    TokenNotAllowed,
    ValueWithTokenCall,
    GasCostTooHigh,
    AssetNotCapped,
    PerTxCapExceeded,
    DailyCapExceeded,
    QueueFull,
    UnknownSpend,
    NotYetExecutable,
    SignFailed,
    /// The asset's `unlisted_per_24h` is zero, so unlisted payees can't be paid in it.
    UnlistedNotAllowed,
    /// Payments to unlisted payees would exceed the asset's `unlisted_per_24h`.
    UnlistedCapExceeded,
    /// The policy has no swap section.
    SwapsDisabled,
    /// The quote isn't signed by the policy's maker key.
    QuoteSignatureInvalid,
    /// The quote, or the transaction paying it, isn't the shape the vault accepts.
    QuoteMismatch,
    /// The quote's deadline is too close, or has passed.
    QuoteExpired,
    /// The quote would expire before the spend's veto window ends.
    QuoteExpiresInQueue,
    /// This quote was already used.
    QuoteReused,
    /// The quote swaps from or to an asset the policy doesn't list.
    SwapAssetNotAllowed,
    /// The quote allows more slippage than the policy.
    SlippageTooHigh,
}

/// Sums payments and the fee per asset, so neither splitting outputs nor paying through fees gets a
/// spend under a cap.
pub fn charges(parsed: &ParsedTx) -> Result<Vec<Charge>, CovenantError> {
    let mut charges: Vec<Charge> = Vec::new();
    let fee = (&parsed.fee_asset, parsed.fee);
    let payments = parsed.payments.iter().map(|p| (&p.asset, p.amount.0));
    for (asset, amount) in payments.chain([fee]) {
        match charges.iter_mut().find(|charge| charge.asset == *asset) {
            Some(charge) => {
                charge.amount.0 = charge
                    .amount
                    .0
                    .checked_add(amount)
                    .ok_or(CovenantError::MalformedTx)?;
            }
            None => charges.push(Charge {
                asset: asset.clone(),
                amount: U128(amount),
            }),
        }
    }
    Ok(charges)
}

/// Checks each charge against its asset's caps. `spent_24h` is what the ledger holds for an asset,
/// reservations included.
pub fn check(
    charges: &[Charge],
    policy: &Policy,
    spent_24h: impl Fn(&AssetId) -> u128,
) -> Result<Decision, CovenantError> {
    let mut decision = Decision::Sign;
    for charge in charges {
        let cap = policy
            .caps
            .iter()
            .find(|cap| cap.asset == charge.asset)
            .ok_or(CovenantError::AssetNotCapped)?;
        if charge.amount.0 > cap.per_tx.0 {
            return Err(CovenantError::PerTxCapExceeded);
        }
        let total = spent_24h(&charge.asset)
            .checked_add(charge.amount.0)
            .ok_or(CovenantError::DailyCapExceeded)?;
        if total > cap.per_24h.0 {
            return Err(CovenantError::DailyCapExceeded);
        }
        if charge.amount.0 >= cap.queue_at.0 {
            decision = Decision::Queue;
        }
    }
    Ok(decision)
}

/// What a spend pays to unlisted payees, summed per asset. Fees aren't included: they count
/// against the asset's main caps, like every other spend.
pub fn unlisted_charges(
    chain: ChainKind,
    parsed: &ParsedTx,
    policy: &Policy,
) -> Result<Vec<Charge>, CovenantError> {
    let mut charges: Vec<Charge> = Vec::new();
    for payment in parsed
        .payments
        .iter()
        .filter(|payment| !policy.is_listed(chain, &payment.to))
    {
        match charges
            .iter_mut()
            .find(|charge| charge.asset == payment.asset)
        {
            Some(charge) => {
                charge.amount.0 = charge
                    .amount
                    .0
                    .checked_add(payment.amount.0)
                    .ok_or(CovenantError::MalformedTx)?;
            }
            None => charges.push(Charge {
                asset: payment.asset.clone(),
                amount: payment.amount,
            }),
        }
    }
    Ok(charges)
}

/// Checks what a spend pays unlisted payees against each asset's `unlisted_per_24h`. Any unlisted
/// payment means the spend is held, so a passing result is always `Queue` when `unlisted` isn't
/// empty. `check` must pass as well: these limits come on top of the main caps.
pub fn check_unlisted(
    unlisted: &[Charge],
    policy: &Policy,
    unlisted_spent_24h: impl Fn(&AssetId) -> u128,
) -> Result<Decision, CovenantError> {
    if unlisted.is_empty() {
        return Ok(Decision::Sign);
    }
    if policy.unlisted != UnlistedPayees::Hold {
        return Err(CovenantError::OutputNotWhitelisted);
    }
    for charge in unlisted {
        let cap = policy
            .caps
            .iter()
            .find(|cap| cap.asset == charge.asset)
            .ok_or(CovenantError::AssetNotCapped)?;
        if cap.unlisted_per_24h.0 == 0 {
            return Err(CovenantError::UnlistedNotAllowed);
        }
        let total = unlisted_spent_24h(&charge.asset)
            .checked_add(charge.amount.0)
            .ok_or(CovenantError::UnlistedCapExceeded)?;
        if total > cap.unlisted_per_24h.0 {
            return Err(CovenantError::UnlistedCapExceeded);
        }
    }
    Ok(Decision::Queue)
}

/// Repeats the adapter rules that depend on policy, for a spend parsed under an earlier policy. A
/// queued spend keeps its parsed form rather than its raw transaction, so this works from that.
pub fn recheck_parsed(
    chain: ChainKind,
    parsed: &ParsedTx,
    policy: &Policy,
) -> Result<(), CovenantError> {
    if !parsed
        .payments
        .iter()
        .all(|payment| policy.allows_payee(chain, &payment.to))
    {
        return Err(CovenantError::OutputNotWhitelisted);
    }
    recheck_fees(chain, parsed, policy)
}

/// The fee and chain rules of `recheck_parsed`, without the payee list. A swap's payment goes to
/// the deposit address its quote signed, so its payee is checked against the swap rules instead.
pub fn recheck_fees(
    chain: ChainKind,
    parsed: &ParsedTx,
    policy: &Policy,
) -> Result<(), CovenantError> {
    match (chain, &parsed.fee_asset) {
        (ChainKind::Bitcoin, _) => {
            if parsed.signing_payloads.len() > policy.btc_max_inputs as usize {
                return Err(CovenantError::TooManyInputs);
            }
            if parsed.fee > policy.btc_max_fee_rate as u128 * parsed.vsize as u128 {
                return Err(CovenantError::FeeTooHigh);
            }
        }
        (ChainKind::Evm, AssetId::EvmNative { chain_id }) => {
            if !policy.evm_chain_ids.contains(chain_id) {
                return Err(CovenantError::WrongChainId);
            }
            if parsed.fee > policy.evm_max_gas_cost.0 {
                return Err(CovenantError::GasCostTooHigh);
            }
        }
        (ChainKind::Solana, AssetId::Sol) => {
            if parsed.fee > policy.sol_max_fee.0 {
                return Err(CovenantError::FeeTooHigh);
            }
        }
        _ => return Err(CovenantError::MalformedTx),
    }
    Ok(())
}

impl fmt::Display for CovenantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

impl std::error::Error for CovenantError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(per_tx: u128, per_24h: u128, queue_at: u128) -> AssetCap {
        AssetCap {
            asset: AssetId::Btc,
            per_tx: U128(per_tx),
            per_24h: U128(per_24h),
            queue_at: U128(queue_at),
            unlisted_per_24h: U128(0),
        }
    }

    fn policy(caps: Vec<AssetCap>) -> Policy {
        Policy {
            caps,
            payees: vec![],
            btc_max_fee_rate: 50,
            btc_max_inputs: 3,
            evm_chain_ids: vec![84532],
            evm_max_gas_cost: U128(1_000_000_000_000_000),
            veto_delay_ns: 120_000_000_000,
            sol_max_fee: U128(100_000),
            unlisted: UnlistedPayees::Refuse,
            unlisted_veto_delay_ns: 0,
            swap: None,
        }
    }

    fn btc_spend(amounts: &[u128], fee: u128) -> ParsedTx {
        ParsedTx {
            payments: amounts
                .iter()
                .map(|amount| Payment {
                    asset: AssetId::Btc,
                    to: vec![0xaa; 22],
                    amount: U128(*amount),
                })
                .collect(),
            fee,
            fee_asset: AssetId::Btc,
            signing_payloads: vec![SignPayload::Ecdsa([0; 32])],
            vsize: 100,
        }
    }

    fn decide(parsed: &ParsedTx, caps: AssetCap, spent: u128) -> Result<Decision, CovenantError> {
        check(&charges(parsed)?, &policy(vec![caps]), |_| spent)
    }

    #[test]
    fn spend_below_every_cap_is_signed() {
        assert_eq!(
            decide(&btc_spend(&[40], 9), cap(100, 500, 50), 0),
            Ok(Decision::Sign)
        );
    }

    #[test]
    fn spend_reaching_queue_threshold_is_queued() {
        assert_eq!(
            decide(&btc_spend(&[40], 10), cap(100, 500, 50), 0),
            Ok(Decision::Queue)
        );
    }

    #[test]
    fn per_tx_cap_is_exact() {
        let caps = cap(100, 500, 50);
        assert_eq!(
            decide(&btc_spend(&[90], 10), caps.clone(), 0),
            Ok(Decision::Queue)
        );
        assert_eq!(
            decide(&btc_spend(&[90], 11), caps, 0),
            Err(CovenantError::PerTxCapExceeded)
        );
    }

    #[test]
    fn btc_split_outputs_cannot_dodge_per_tx_cap() {
        let split = btc_spend(&[40; 8], 1);
        assert_eq!(
            decide(&split, cap(100, 500, 50), 0),
            Err(CovenantError::PerTxCapExceeded)
        );
    }

    #[test]
    fn btc_split_outputs_cannot_dodge_queue() {
        let split = btc_spend(&[20; 3], 1);
        assert_eq!(decide(&split, cap(100, 500, 50), 0), Ok(Decision::Queue));
    }

    #[test]
    fn btc_fee_counts_against_daily_cap() {
        let spend = btc_spend(&[40], 5);
        assert_eq!(decide(&spend, cap(100, 500, 50), 455), Ok(Decision::Sign));
        assert_eq!(
            decide(&spend, cap(100, 500, 50), 456),
            Err(CovenantError::DailyCapExceeded)
        );
    }

    #[test]
    fn self_spend_still_pays_its_fee_from_the_cap() {
        assert_eq!(
            decide(&btc_spend(&[], 5), cap(100, 500, 50), 496),
            Err(CovenantError::DailyCapExceeded)
        );
    }

    #[test]
    fn uncapped_asset_is_refused() {
        let mut spend = btc_spend(&[40], 5);
        spend.payments[0].asset = AssetId::Sol;
        assert_eq!(
            decide(&spend, cap(100, 500, 50), 0),
            Err(CovenantError::AssetNotCapped)
        );
    }

    #[test]
    fn token_spend_needs_a_cap_for_its_gas() {
        let token = AssetId::Erc20 {
            chain_id: 84532,
            token: [1; 20],
        };
        let gas = AssetId::EvmNative { chain_id: 84532 };
        let spend = ParsedTx {
            payments: vec![Payment {
                asset: token.clone(),
                to: vec![0xaa; 20],
                amount: U128(40),
            }],
            fee: 5,
            fee_asset: gas.clone(),
            signing_payloads: vec![SignPayload::Ecdsa([0; 32])],
            vsize: 0,
        };
        let mut token_cap = cap(100, 500, 50);
        token_cap.asset = token;
        assert_eq!(
            decide(&spend, token_cap.clone(), 0),
            Err(CovenantError::AssetNotCapped)
        );
        let mut gas_cap = cap(100, 500, 50);
        gas_cap.asset = gas;
        let both = policy(vec![token_cap, gas_cap]);
        assert_eq!(
            check(&charges(&spend).unwrap(), &both, |_| 0),
            Ok(Decision::Sign)
        );
    }

    #[test]
    fn recheck_catches_each_tightened_bitcoin_rule() {
        let spend = btc_spend(&[40], 5);
        let mut rules = policy(vec![]);
        rules.payees = vec![Payee {
            chain: ChainKind::Bitcoin,
            to: vec![0xaa; 22],
            label: "supplier".into(),
        }];
        assert_eq!(recheck_parsed(ChainKind::Bitcoin, &spend, &rules), Ok(()));

        let mut other_chain = rules.clone();
        other_chain.payees[0].chain = ChainKind::Evm;
        assert_eq!(
            recheck_parsed(ChainKind::Bitcoin, &spend, &other_chain),
            Err(CovenantError::OutputNotWhitelisted)
        );
        let mut fewer_inputs = rules.clone();
        fewer_inputs.btc_max_inputs = 0;
        assert_eq!(
            recheck_parsed(ChainKind::Bitcoin, &spend, &fewer_inputs),
            Err(CovenantError::TooManyInputs)
        );
        let mut lower_fee = rules;
        lower_fee.btc_max_fee_rate = 0;
        assert_eq!(
            recheck_parsed(ChainKind::Bitcoin, &spend, &lower_fee),
            Err(CovenantError::FeeTooHigh)
        );
    }

    #[test]
    fn recheck_catches_each_tightened_evm_rule() {
        let spend = ParsedTx {
            payments: vec![Payment {
                asset: AssetId::EvmNative { chain_id: 84532 },
                to: vec![0xaa; 20],
                amount: U128(40),
            }],
            fee: 5,
            fee_asset: AssetId::EvmNative { chain_id: 84532 },
            signing_payloads: vec![SignPayload::Ecdsa([0; 32])],
            vsize: 0,
        };
        let mut rules = policy(vec![]);
        rules.payees = vec![Payee {
            chain: ChainKind::Evm,
            to: vec![0xaa; 20],
            label: "supplier".into(),
        }];
        assert_eq!(recheck_parsed(ChainKind::Evm, &spend, &rules), Ok(()));

        let mut other_chain = rules.clone();
        other_chain.evm_chain_ids = vec![1];
        assert_eq!(
            recheck_parsed(ChainKind::Evm, &spend, &other_chain),
            Err(CovenantError::WrongChainId)
        );
        let mut lower_gas = rules;
        lower_gas.evm_max_gas_cost = U128(4);
        assert_eq!(
            recheck_parsed(ChainKind::Evm, &spend, &lower_gas),
            Err(CovenantError::GasCostTooHigh)
        );
    }

    #[test]
    fn recheck_catches_each_tightened_solana_rule() {
        let spend = ParsedTx {
            payments: vec![Payment {
                asset: AssetId::Sol,
                to: vec![0xaa; 32],
                amount: U128(40),
            }],
            fee: 5_000,
            fee_asset: AssetId::Sol,
            signing_payloads: vec![SignPayload::Eddsa(vec![1; 100].into())],
            vsize: 0,
        };
        let mut rules = policy(vec![]);
        rules.payees = vec![Payee {
            chain: ChainKind::Solana,
            to: vec![0xaa; 32],
            label: "supplier".into(),
        }];
        assert_eq!(recheck_parsed(ChainKind::Solana, &spend, &rules), Ok(()));

        let mut other_chain = rules.clone();
        other_chain.payees[0].chain = ChainKind::Evm;
        assert_eq!(
            recheck_parsed(ChainKind::Solana, &spend, &other_chain),
            Err(CovenantError::OutputNotWhitelisted)
        );
        let mut lower_fee = rules;
        lower_fee.sol_max_fee = U128(4_999);
        assert_eq!(
            recheck_parsed(ChainKind::Solana, &spend, &lower_fee),
            Err(CovenantError::FeeTooHigh)
        );
    }

    #[test]
    fn policy_without_a_solana_fee_cap_refuses_solana() {
        let old = near_sdk::serde_json::json!({
            "caps": [], "payees": [], "btc_max_fee_rate": 50, "btc_max_inputs": 3,
            "evm_chain_ids": [84532], "evm_max_gas_cost": "1", "veto_delay_ns": 1u64,
        });
        let policy: Policy = near_sdk::serde_json::from_value(old).unwrap();
        assert_eq!(policy.sol_max_fee, U128(0));
    }

    #[test]
    fn charges_that_overflow_are_refused() {
        let spend = btc_spend(&[u128::MAX, 1], 0);
        assert_eq!(charges(&spend), Err(CovenantError::MalformedTx));
    }

    #[test]
    fn spent_that_overflows_is_refused() {
        assert_eq!(
            decide(&btc_spend(&[40], 5), cap(100, 500, 50), u128::MAX),
            Err(CovenantError::DailyCapExceeded)
        );
    }

    #[test]
    fn validate_accepts_sane_caps() {
        assert_eq!(policy(vec![cap(100, 500, 50)]).validate(), Ok(()));
    }

    #[test]
    fn validate_rejects_zero_caps() {
        assert!(policy(vec![cap(0, 500, 50)]).validate().is_err());
        assert!(policy(vec![cap(100, 0, 50)]).validate().is_err());
        assert!(policy(vec![cap(100, 500, 0)]).validate().is_err());
    }

    #[test]
    fn validate_rejects_queue_threshold_above_per_tx() {
        assert!(policy(vec![cap(100, 500, 101)]).validate().is_err());
    }

    #[test]
    fn error_display_is_the_variant_name() {
        assert_eq!(
            CovenantError::OutputNotWhitelisted.to_string(),
            "OutputNotWhitelisted"
        );
    }

    #[test]
    fn amounts_cross_json_as_strings() {
        let json = near_sdk::serde_json::to_value(cap(1, 2, 1)).unwrap();
        assert_eq!(json["per_tx"], "1");
    }

    mod unlisted {
        use super::*;

        const LISTED: [u8; 22] = [0xaa; 22];

        fn open(unlisted_per_24h: u128) -> Policy {
            let mut caps = cap(100, 500, 50);
            caps.unlisted_per_24h = U128(unlisted_per_24h);
            let mut rules = policy(vec![caps]);
            rules.payees = vec![Payee {
                chain: ChainKind::Bitcoin,
                to: LISTED.to_vec(),
                label: "supplier".into(),
            }];
            rules.unlisted = UnlistedPayees::Hold;
            rules.unlisted_veto_delay_ns = 600_000_000_000;
            rules
        }

        fn pay(to: &[u8], amount: u128) -> Payment {
            Payment {
                asset: AssetId::Btc,
                to: to.to_vec(),
                amount: U128(amount),
            }
        }

        fn spend(payments: Vec<Payment>) -> ParsedTx {
            ParsedTx {
                payments,
                fee: 1,
                fee_asset: AssetId::Btc,
                signing_payloads: vec![SignPayload::Ecdsa([0; 32])],
                vsize: 100,
            }
        }

        fn hold(parsed: &ParsedTx, rules: &Policy, spent: u128) -> Result<Decision, CovenantError> {
            let unlisted = unlisted_charges(ChainKind::Bitcoin, parsed, rules)?;
            check_unlisted(&unlisted, rules, |_| spent)
        }

        #[test]
        fn unlisted_payee_is_always_held() {
            let rules = open(200);
            let small = spend(vec![pay(&[0xbb; 22], 1)]);
            assert_eq!(
                check(&charges(&small).unwrap(), &rules, |_| 0),
                Ok(Decision::Sign)
            );
            assert_eq!(hold(&small, &rules, 0), Ok(Decision::Queue));
        }

        #[test]
        fn listed_payee_is_not_held_by_the_unlisted_rule() {
            let rules = open(200);
            let listed = spend(vec![pay(&LISTED, 40)]);
            assert_eq!(
                unlisted_charges(ChainKind::Bitcoin, &listed, &rules),
                Ok(vec![])
            );
            assert_eq!(hold(&listed, &rules, 0), Ok(Decision::Sign));
        }

        #[test]
        fn a_payee_listed_for_another_chain_is_unlisted() {
            let mut rules = open(200);
            rules.payees[0].chain = ChainKind::Evm;
            let other = spend(vec![pay(&LISTED, 40)]);
            assert_eq!(hold(&other, &rules, 0), Ok(Decision::Queue));
        }

        #[test]
        fn refuse_mode_still_refuses() {
            let mut rules = open(200);
            rules.unlisted = UnlistedPayees::Refuse;
            assert!(!rules.allows_payee(ChainKind::Bitcoin, &[0xbb; 22]));
            assert!(rules.allows_payee(ChainKind::Bitcoin, &LISTED));
            let stranger = spend(vec![pay(&[0xbb; 22], 1)]);
            assert_eq!(
                hold(&stranger, &rules, 0),
                Err(CovenantError::OutputNotWhitelisted)
            );
            let parsed = spend(vec![pay(&[0xbb; 22], 1)]);
            assert_eq!(
                recheck_parsed(ChainKind::Bitcoin, &parsed, &rules),
                Err(CovenantError::OutputNotWhitelisted)
            );
            rules.unlisted = UnlistedPayees::Hold;
            assert_eq!(recheck_parsed(ChainKind::Bitcoin, &parsed, &rules), Ok(()));
        }

        #[test]
        fn unlisted_cap_counts_split_outputs() {
            let rules = open(100);
            let split = spend(vec![
                pay(&[0xbb; 22], 30),
                pay(&[0xcc; 22], 30),
                pay(&[0xbb; 22], 30),
                pay(&LISTED, 9),
            ]);
            let unlisted = unlisted_charges(ChainKind::Bitcoin, &split, &rules).unwrap();
            assert_eq!(
                unlisted,
                vec![Charge {
                    asset: AssetId::Btc,
                    amount: U128(90),
                }]
            );
            assert_eq!(hold(&split, &rules, 10), Ok(Decision::Queue));
            assert_eq!(
                hold(&split, &rules, 11),
                Err(CovenantError::UnlistedCapExceeded)
            );
        }

        #[test]
        fn zero_unlisted_cap_refuses_the_asset() {
            let rules = open(0);
            let stranger = spend(vec![pay(&[0xbb; 22], 1)]);
            assert_eq!(
                hold(&stranger, &rules, 0),
                Err(CovenantError::UnlistedNotAllowed)
            );
        }

        #[test]
        fn unlisted_cap_does_not_lift_the_main_caps() {
            let rules = open(500);
            let big = spend(vec![pay(&[0xbb; 22], 150)]);
            assert_eq!(hold(&big, &rules, 0), Ok(Decision::Queue));
            assert_eq!(
                check(&charges(&big).unwrap(), &rules, |_| 0),
                Err(CovenantError::PerTxCapExceeded)
            );
        }

        #[test]
        fn delay_is_the_longer_window_for_unlisted() {
            let rules = open(200);
            assert_eq!(rules.delay_for(false), 120_000_000_000);
            assert_eq!(rules.delay_for(true), 600_000_000_000);
        }

        #[test]
        fn validate_checks_the_unlisted_rules() {
            let mut rules = open(200);
            assert_eq!(rules.validate(), Ok(()));
            rules.unlisted_veto_delay_ns = rules.veto_delay_ns - 1;
            assert!(rules.validate().is_err());
            rules.unlisted = UnlistedPayees::Refuse;
            assert_eq!(rules.validate(), Ok(()));
            let mut over = open(501);
            over.unlisted_veto_delay_ns = over.veto_delay_ns;
            assert!(over.validate().is_err());
        }

        #[test]
        fn a_policy_without_the_new_fields_refuses_unlisted() {
            let json = near_sdk::serde_json::json!({
                "caps": [{ "asset": "Btc", "per_tx": "100", "per_24h": "500", "queue_at": "50" }],
                "payees": [],
                "btc_max_fee_rate": 50,
                "btc_max_inputs": 3,
                "evm_chain_ids": [84532],
                "evm_max_gas_cost": "1",
                "veto_delay_ns": 1u64,
            });
            let rules: Policy = near_sdk::serde_json::from_value(json).unwrap();
            assert_eq!(rules.unlisted, UnlistedPayees::Refuse);
            assert_eq!(rules.caps[0].unlisted_per_24h, U128(0));
        }
    }
}

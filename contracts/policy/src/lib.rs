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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedTx {
    /// External outputs only; Bitcoin change is removed.
    pub payments: Vec<Payment>,
    /// Sats, or max wei.
    pub fee: u128,
    /// One per Bitcoin input; one for EVM.
    pub signing_hashes: Vec<[u8; 32]>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetCap {
    pub asset: AssetId,
    pub per_tx: U128,
    pub per_24h: U128,
    pub queue_at: U128,
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
        }
        Ok(())
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
        }
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
}

//! Bitcoin adapter: P2WPKH vault inputs, SIGHASH_ALL, allow-listed outputs, change to the vault.
//! See docs/SPEC.md, "Bitcoin adapter spec".

use covenant_policy::{CovenantError, ParsedTx, Policy, TxMeta};

/// The vault's own Bitcoin key, used to recognise its inputs and change.
pub struct BitcoinVault<'a> {
    pub pubkey: &'a [u8; 33],
}

/// Parses an unsigned transaction into payments and one BIP143 sighash per input.
///
/// Not implemented yet, so it refuses every transaction.
pub fn parse(
    _tx: &[u8],
    _meta: &TxMeta,
    _policy: &Policy,
    _vault: &BitcoinVault<'_>,
) -> Result<ParsedTx, CovenantError> {
    Err(CovenantError::MalformedTx)
}

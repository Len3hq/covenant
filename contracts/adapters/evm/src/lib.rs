//! EVM adapter: EIP-1559 only, native transfer or one exact ERC-20 `transfer`.
//! See docs/SPEC.md, "EVM adapter spec".

use covenant_policy::{CovenantError, ParsedTx, Policy};

/// Parses an unsigned type-2 transaction into payments and its keccak256 signing hash.
///
/// Not implemented yet, so it refuses every transaction.
pub fn parse(_tx: &[u8], _policy: &Policy) -> Result<ParsedTx, CovenantError> {
    Err(CovenantError::MalformedTx)
}

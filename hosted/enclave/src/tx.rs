//! One NEAR function call from a hosted agent, rebuilt here from its fields. The key holder signs
//! the hash of bytes it encoded itself, never bytes or a digest it was handed.

use base64::Engine;
use borsh::BorshSerialize;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The only calls a hosted agent makes, matching its access key's method list.
const AGENT_METHODS: [&str; 2] = ["propose_spend", "execute"];
/// NEAR's gas limit for one call.
const MAX_GAS: u64 = 300_000_000_000_000;

/// As the SDK's `AgentCall` sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCall {
    pub signer_id: String,
    pub public_key: String,
    pub nonce: String,
    pub receiver_id: String,
    pub block_hash: String,
    pub method: String,
    /// Base64.
    pub args: String,
    pub gas: String,
}

#[derive(BorshSerialize)]
struct Ed25519PublicKey {
    key_type: u8,
    data: [u8; 32],
}

#[derive(BorshSerialize)]
struct FunctionCall {
    method_name: String,
    args: Vec<u8>,
    gas: u64,
    deposit: u128,
}

#[derive(BorshSerialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
enum Action {
    FunctionCall(FunctionCall) = 2,
}

#[derive(BorshSerialize)]
struct Transaction {
    signer_id: String,
    public_key: Ed25519PublicKey,
    nonce: u64,
    receiver_id: String,
    block_hash: [u8; 32],
    actions: Vec<Action>,
}

/// `ed25519:<base58>` as its 32 bytes.
pub fn parse_ed25519(key: &str) -> Result<[u8; 32], String> {
    let encoded = key
        .strip_prefix("ed25519:")
        .ok_or("a public key starts with ed25519:")?;
    let bytes = bs58::decode(encoded)
        .into_vec()
        .map_err(|_| "a public key is base58")?;
    bytes
        .try_into()
        .map_err(|_| "an ed25519 public key is 32 bytes".to_string())
}

/// The transaction's bytes, once its fields pass: a call to `propose_spend` or `execute`, with no
/// deposit, at most 300 Tgas, signed by `own_key`.
pub fn encode(call: &AgentCall, own_key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if !AGENT_METHODS.contains(&call.method.as_str()) {
        return Err(format!("a hosted agent may not call {}", call.method));
    }
    if &parse_ed25519(&call.public_key)? != own_key {
        return Err("that call is for another key".into());
    }
    let gas: u64 = call.gas.parse().map_err(|_| "gas is a whole number")?;
    if gas == 0 || gas > MAX_GAS {
        return Err("gas is above NEAR's limit".into());
    }
    let block_hash: [u8; 32] = bs58::decode(&call.block_hash)
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("a block hash is 32 bytes of base58")?;
    let args = base64::engine::general_purpose::STANDARD
        .decode(&call.args)
        .map_err(|_| "args are base64")?;
    let transaction = Transaction {
        signer_id: call.signer_id.clone(),
        public_key: Ed25519PublicKey {
            key_type: 0,
            data: *own_key,
        },
        nonce: call
            .nonce
            .parse()
            .map_err(|_| "the nonce is a whole number")?,
        receiver_id: call.receiver_id.clone(),
        block_hash,
        actions: vec![Action::FunctionCall(FunctionCall {
            method_name: call.method.clone(),
            args,
            gas,
            deposit: 0,
        })],
    };
    borsh::to_vec(&transaction).map_err(|e| e.to_string())
}

pub fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encoded by near-api-js's `encodeTransaction` for the same fields (sdk/src/signer.test.ts).
    const VECTOR: &str = include_str!("../../../tests/vectors/agent_call.json");

    #[derive(Deserialize)]
    struct Vector {
        call: AgentCall,
        encoded_hex: String,
    }

    fn vector() -> Vector {
        serde_json::from_str(VECTOR).unwrap()
    }

    #[test]
    fn encodes_as_near_api_js_does() {
        let v = vector();
        let key = parse_ed25519(&v.call.public_key).unwrap();
        let bytes = encode(&v.call, &key).unwrap();
        assert_eq!(hex_lower(&bytes), v.encoded_hex);
    }

    #[test]
    fn refuses_other_methods_keys_and_gas() {
        let v = vector();
        let key = parse_ed25519(&v.call.public_key).unwrap();
        let other = AgentCall {
            method: "set_agent".into(),
            ..v.call.clone()
        };
        assert!(encode(&other, &key)
            .unwrap_err()
            .contains("may not call set_agent"));
        assert!(encode(&v.call, &[9; 32])
            .unwrap_err()
            .contains("another key"));
        let greedy = AgentCall {
            gas: "300000000000001".into(),
            ..v.call.clone()
        };
        assert!(encode(&greedy, &key).unwrap_err().contains("gas"));
    }

    fn hex_lower(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

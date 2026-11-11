//! The hosted connector's key holder, run by OutLayer in an Intel TDX enclave. It holds one ed25519
//! key that only the enclave can use, the access key of every hosted agent, and signs a vault call
//! only when the vault's owner granted it. docs/HOSTED.md has the design.
//!
//! Input on stdin: `{"operation": "public_key"}`, or
//! `{"operation": "sign_call", "call": <AgentCall>, "grant": <Grant>}`.
//! Output on stdout: `{"public_key": ...}`, `{"signature": <base64>}`, or `{"error": ...}`.

mod grant;
mod rpc;
mod tx;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;

/// The manifest, in the wasm's `outlayer.manifest` section, so its hash covers it.
#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

mod bindings {
    wit_bindgen::generate!({ world: "signing-keys-host", path: "wit" });
}
use bindings::outlayer::signing_keys::api as signing_keys;

const KEY_PATH: &str = "agent";

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    PublicKey {},
    SignCall {
        call: Box<tx::AgentCall>,
        grant: Box<grant::Grant>,
    },
}

fn main() {
    let mut raw = String::new();
    let answer = match std::io::stdin().read_to_string(&mut raw) {
        Ok(_) => match serde_json::from_str::<Input>(&raw) {
            Ok(input) => run(input).unwrap_or_else(|error| json!({ "error": error })),
            Err(error) => json!({ "error": format!("unreadable input: {error}") }),
        },
        Err(error) => json!({ "error": error.to_string() }),
    };
    print!("{answer}");
}

fn own_key() -> Result<[u8; 32], String> {
    signing_keys::public_key(KEY_PATH, None)?
        .try_into()
        .map_err(|_| "the host's key isn't 32 bytes".to_string())
}

fn run(input: Input) -> Result<Value, String> {
    let key = own_key()?;
    match input {
        Input::PublicKey {} => {
            Ok(json!({ "public_key": format!("ed25519:{}", bs58::encode(key).into_string()) }))
        }
        Input::SignCall { call, grant } => {
            let terms = grant::verify(&grant)?;
            check_terms(&terms, &call, now()?)?;
            if !rpc::is_full_access(&terms.owner, &grant.public_key)? {
                return Err(format!(
                    "the grant's key isn't a full-access key of {}",
                    terms.owner
                ));
            }
            let roles = rpc::roles(&terms.vault)?;
            if roles.owner != terms.owner || roles.agent != terms.agent {
                return Err(format!(
                    "{} doesn't name {} as owner and {} as agent",
                    terms.vault, terms.owner, terms.agent
                ));
            }
            let hash = tx::hash(&tx::encode(&call, &key)?);
            let signature = signing_keys::sign(KEY_PATH, None, &hash)?;
            Ok(json!({ "signature": base64::engine::general_purpose::STANDARD.encode(signature) }))
        }
    }
}

/// The call is the granted agent's, to the granted vault, before the grant expires.
fn check_terms(terms: &grant::Terms, call: &tx::AgentCall, now: u64) -> Result<(), String> {
    if call.receiver_id != terms.vault || call.signer_id != terms.agent {
        return Err("the grant is for another vault or agent".into());
    }
    if now >= terms.expires {
        return Err("the grant has expired".into());
    }
    Ok(())
}

fn now() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .map_err(|_| "the enclave's clock is before 1970".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> grant::Terms {
        grant::Terms {
            owner: "o.testnet".into(),
            vault: "v.testnet".into(),
            agent: "a.testnet".into(),
            expires: 100,
        }
    }

    fn call(signer: &str, receiver: &str) -> tx::AgentCall {
        serde_json::from_value(json!({
            "signerId": signer, "publicKey": "ed25519:11111111111111111111111111111111", "nonce": "1",
            "receiverId": receiver, "blockHash": "11111111111111111111111111111111", "method": "execute",
            "args": "", "gas": "1"
        }))
        .unwrap()
    }

    #[test]
    fn a_grant_covers_only_its_vault_and_agent_until_it_expires() {
        assert!(check_terms(&terms(), &call("a.testnet", "v.testnet"), 99).is_ok());
        assert!(check_terms(&terms(), &call("a.testnet", "other.testnet"), 99).is_err());
        assert!(check_terms(&terms(), &call("b.testnet", "v.testnet"), 99).is_err());
        assert!(check_terms(&terms(), &call("a.testnet", "v.testnet"), 100)
            .unwrap_err()
            .contains("expired"));
    }

    #[test]
    fn unknown_operations_and_fields_are_refused() {
        assert!(serde_json::from_str::<Input>(r#"{"operation":"sign"}"#).is_err());
        assert!(serde_json::from_str::<Input>(r#"{"operation":"public_key","path":"x"}"#).is_err());
    }
}

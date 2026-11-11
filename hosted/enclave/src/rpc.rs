//! Reads from NEAR testnet, from inside the enclave, so whether a grant's key and owner are real is
//! checked against the chain rather than taken from the caller. The endpoints are fixed here: no
//! input can point the check at another server.

use serde::Deserialize;
use serde_json::{json, Value};

const ENDPOINTS: [&str; 2] = [
    "https://rpc.testnet.fastnear.com",
    "https://near-testnet.drpc.org",
];

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Roles {
    pub owner: String,
    pub agent: String,
}

fn query(params: Value) -> Result<Value, String> {
    let body = json!({"jsonrpc": "2.0", "id": "covenant", "method": "query", "params": params})
        .to_string();
    let mut last = String::from("no RPC answered");
    for url in ENDPOINTS {
        match post(url, body.as_bytes()) {
            Ok(answer) => {
                let parsed: Value = serde_json::from_slice(&answer)
                    .map_err(|_| format!("{url} answered something else"))?;
                if let Some(result) = parsed.get("result") {
                    return Ok(result.clone());
                }
                last = format!(
                    "{url}: {}",
                    parsed
                        .get("error")
                        .map(Value::to_string)
                        .unwrap_or_default()
                );
            }
            Err(error) => last = format!("{url}: {error}"),
        }
    }
    Err(last)
}

#[cfg(target_arch = "wasm32")]
fn post(url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
    let response = wasi_http_client::Client::new()
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|e| e.to_string())?;
    response.body().map_err(|e| e.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn post(_url: &str, _body: &[u8]) -> Result<Vec<u8>, String> {
    Err("no network outside the enclave".into())
}

/// Whether `public_key` is a full-access key of `account`. A missing key is `false`, not an error.
pub fn is_full_access(account: &str, public_key: &str) -> Result<bool, String> {
    let params = json!({"request_type": "view_access_key", "finality": "final", "account_id": account, "public_key": public_key});
    match query(params) {
        Ok(result) => Ok(result.get("permission") == Some(&json!("FullAccess"))),
        Err(error) if error.contains("UNKNOWN_ACCESS_KEY") || error.contains("does not exist") => {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

/// The vault's owner and agent, from its own `get_roles`.
pub fn roles(vault: &str) -> Result<Roles, String> {
    let params = json!({"request_type": "call_function", "finality": "final", "account_id": vault, "method_name": "get_roles", "args_base64": ""});
    let result = query(params)?;
    let bytes: Vec<u8> = serde_json::from_value(
        result
            .get("result")
            .cloned()
            .ok_or("get_roles gave no result")?,
    )
    .map_err(|_| "get_roles gave no bytes")?;
    serde_json::from_slice(&bytes).map_err(|_| format!("{vault} isn't a Covenant vault"))
}

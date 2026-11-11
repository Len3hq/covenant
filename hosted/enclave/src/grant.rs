//! A vault owner's permission for the hosted connector to drive one agent, signed with the owner's
//! wallet as a NEP-413 message. Without a live one, the key holder signs nothing.

use base64::Engine;
use borsh::BorshSerialize;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The NEP-413 recipient every grant names, so a grant is no login anywhere else.
pub const RECIPIENT: &str = "covenant-hosted";
const PREFIX: &str = "covenant-hosted:v1";
/// NEP-413's tag, 2^31 + 413, which keeps the signed bytes from being a transaction.
const NEP413_TAG: u32 = (1 << 31) + 413;

/// As the owner's wallet answered `signMessage`, with the message and nonce it signed.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub message: String,
    /// Base64, 32 bytes.
    pub nonce: String,
    /// `ed25519:<base58>`, one of the owner's full-access keys.
    pub public_key: String,
    /// Base64, 64 bytes.
    pub signature: String,
}

/// What a grant allows.
#[derive(Debug, PartialEq, Eq)]
pub struct Terms {
    pub owner: String,
    pub vault: String,
    pub agent: String,
    pub expires: u64,
}

#[derive(BorshSerialize)]
struct Payload<'a> {
    message: &'a str,
    nonce: [u8; 32],
    recipient: &'a str,
    callback_url: Option<String>,
}

#[cfg(test)]
/// The message an owner signs: `covenant-hosted:v1 owner=<o> vault=<v> agent=<a> expires=<unix s>`.
pub fn message(terms: &Terms) -> String {
    format!(
        "{PREFIX} owner={} vault={} agent={} expires={}",
        terms.owner, terms.vault, terms.agent, terms.expires
    )
}

/// The grant's terms, once its signature verifies under the key it names. Whether that key is
/// the owner's, and the owner the vault's, is checked against NEAR afterwards.
pub fn verify(grant: &Grant) -> Result<Terms, String> {
    let terms = parse(&grant.message)?;
    let engine = base64::engine::general_purpose::STANDARD;
    let nonce: [u8; 32] = engine
        .decode(&grant.nonce)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("a grant's nonce is 32 bytes of base64")?;
    let signature: [u8; 64] = engine
        .decode(&grant.signature)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("a grant's signature is 64 bytes of base64")?;
    let key = VerifyingKey::from_bytes(&crate::tx::parse_ed25519(&grant.public_key)?)
        .map_err(|_| "a grant's key isn't an ed25519 point")?;
    let payload = Payload {
        message: &grant.message,
        nonce,
        recipient: RECIPIENT,
        callback_url: None,
    };
    let mut bytes = borsh::to_vec(&NEP413_TAG).map_err(|e| e.to_string())?;
    bytes.extend(borsh::to_vec(&payload).map_err(|e| e.to_string())?);
    let hash: [u8; 32] = Sha256::digest(&bytes).into();
    key.verify_strict(&hash, &Signature::from_bytes(&signature))
        .map_err(|_| "the grant's signature doesn't verify")?;
    Ok(terms)
}

fn parse(message: &str) -> Result<Terms, String> {
    let mut parts = message.split(' ');
    if parts.next() != Some(PREFIX) {
        return Err(format!("a grant starts with {PREFIX}"));
    }
    let mut field = |name: &str| -> Result<String, String> {
        parts
            .next()
            .and_then(|part| part.strip_prefix(name)?.strip_prefix('='))
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("a grant names {name}"))
    };
    let terms = Terms {
        owner: field("owner")?,
        vault: field("vault")?,
        agent: field("agent")?,
        expires: field("expires")?
            .parse()
            .map_err(|_| "a grant's expiry is unix seconds")?,
    };
    if parts.next().is_some() {
        return Err("a grant says nothing more".into());
    }
    Ok(terms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed(message: &str, key: &SigningKey) -> Grant {
        let nonce = [7u8; 32];
        let payload = Payload {
            message,
            nonce,
            recipient: RECIPIENT,
            callback_url: None,
        };
        let mut bytes = borsh::to_vec(&NEP413_TAG).unwrap();
        bytes.extend(borsh::to_vec(&payload).unwrap());
        let hash: [u8; 32] = Sha256::digest(&bytes).into();
        let engine = base64::engine::general_purpose::STANDARD;
        Grant {
            message: message.into(),
            nonce: engine.encode(nonce),
            public_key: format!(
                "ed25519:{}",
                bs58::encode(key.verifying_key().as_bytes()).into_string()
            ),
            signature: engine.encode(key.sign(&hash).to_bytes()),
        }
    }

    fn terms() -> Terms {
        Terms {
            owner: "frankieme.testnet".into(),
            vault: "frank.vaults-v3.len3hq.testnet".into(),
            agent: "hosted.frankieme.testnet".into(),
            expires: 1_900_000_000,
        }
    }

    #[test]
    fn a_signed_grant_gives_its_terms() {
        let key = SigningKey::from_bytes(&[1; 32]);
        assert_eq!(verify(&signed(&message(&terms()), &key)).unwrap(), terms());
    }

    /// Signed through near-api-js, as a NEAR wallet signs (hosted/connector checks it too).
    #[test]
    fn verifies_a_wallet_signed_grant() {
        #[derive(Deserialize)]
        struct Vector {
            grant: Grant,
        }
        let vector: Vector =
            serde_json::from_str(include_str!("../../../tests/vectors/grant.json")).unwrap();
        assert_eq!(verify(&vector.grant).unwrap(), terms());
    }

    #[test]
    fn a_changed_or_padded_grant_fails() {
        let key = SigningKey::from_bytes(&[1; 32]);
        let mut grant = signed(&message(&terms()), &key);
        grant.message = grant.message.replace("frank.vaults", "other.vaults");
        assert!(verify(&grant).unwrap_err().contains("doesn't verify"));
        let padded = signed(&format!("{} extra=1", message(&terms())), &key);
        assert!(verify(&padded).unwrap_err().contains("nothing more"));
        let wrong = signed("covenant-hosted:v2 owner=a vault=b agent=c expires=1", &key);
        assert!(verify(&wrong).is_err());
    }
}

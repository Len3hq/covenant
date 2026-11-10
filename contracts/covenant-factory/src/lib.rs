//! Creates vaults. Each one is a separate account, `<name>.<factory>`, owned by whoever asked for
//! it. It runs the global contract named by `vault_code_hash` and has no access keys, so nobody can
//! change its code, including us. The factory has no owner, and no method that touches a vault
//! after creating it.
//!
//! The vault's addresses come from the MPC signer, never the caller. A wrong address would strand
//! whatever was sent to it, so the form that builds this call doesn't get a say.

use covenant_policy::Policy;
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PublicKey,
};

const BTC_PATH: &str = "btc-vault-1";
const EVM_PATH: &str = "evm-vault-1";
const SOL_PATH: &str = "sol-vault-1";
const SECP256K1_DOMAIN: u32 = 0;
const ED25519_DOMAIN: u32 = 1;

const KEY_GAS: Gas = Gas::from_tgas(15);
const NEW_GAS: Gas = Gas::from_tgas(60);
const ON_CREATED_GAS: Gas = Gas::from_tgas(20);
const ON_KEYS_GAS: Gas = Gas::from_tgas(120);
/// Everything above plus this call's own work, so too little fails before anything is sent.
const MIN_GAS: Gas = Gas::from_tgas(200);

/// Kept by the factory to store the `vaults_of` entry. A vault's name is at most 64 bytes, so this
/// covers it many times over, and creating vaults can never drain the factory.
const REGISTRY_FEE: NearToken = NearToken::from_millinear(10);
/// A vault's storage and `sign` deposits need about this much. Below 1 NEAR the dashboard warns.
const MIN_DEPOSIT: NearToken = NearToken::from_millinear(1100);
/// Well above the signer's answer, which is under 100 bytes.
const MAX_KEY_LEN: usize = 256;
const SECP256K1_TAG: u8 = 1;
const ED25519_TAG: u8 = 0;
const POINT_LEN: usize = 64;
const ED25519_LEN: usize = 32;

/// NEP-297 events. Each logs as `EVENT_JSON:{"standard":"covenant-factory",...}`.
#[near(event_json(standard = "covenant-factory"))]
pub enum FactoryEvent {
    #[event_version("1.0.0")]
    VaultCreated {
        vault: AccountId,
        owner: AccountId,
        agent: AccountId,
    },
    #[event_version("1.0.0")]
    VaultNotCreated {
        vault: AccountId,
        owner: AccountId,
        reason: String,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CovenantFactory {
    signer: AccountId,
    vault_code_hash: CryptoHash,
    vaults: LookupMap<AccountId, Vec<AccountId>>,
}

/// The Bitcoin key `new` needs, from the derived point.
fn compressed(point: &[u8; POINT_LEN]) -> [u8; 33] {
    let mut key = [0u8; 33];
    key[0] = 0x02 + (point[POINT_LEN - 1] & 1);
    key[1..].copy_from_slice(&point[..32]);
    key
}

fn evm_address(point: &[u8; POINT_LEN]) -> [u8; 20] {
    let hash = env::keccak256_array(point);
    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..]);
    address
}

/// The point in the signer's `secp256k1:<base58>` answer, or None for anything else.
fn parse_point(answer: &[u8]) -> Option<[u8; POINT_LEN]> {
    let text: String = serde_json::from_slice(answer).ok()?;
    let key: PublicKey = text.parse().ok()?;
    let (tag, point) = key.as_bytes().split_first()?;
    if *tag != SECP256K1_TAG {
        return None;
    }
    point.try_into().ok()
}

/// The key in the signer's `ed25519:<base58>` answer, which is the vault's Solana address.
fn parse_ed25519(answer: &[u8]) -> Option<[u8; ED25519_LEN]> {
    let text: String = serde_json::from_slice(answer).ok()?;
    let key: PublicKey = text.parse().ok()?;
    let (tag, key) = key.as_bytes().split_first()?;
    if *tag != ED25519_TAG {
        return None;
    }
    key.try_into().ok()
}

fn key_result(index: u64) -> Option<[u8; POINT_LEN]> {
    parse_point(&env::promise_result_checked(index, MAX_KEY_LEN).ok()?)
}

fn ed25519_result(index: u64) -> Option<[u8; ED25519_LEN]> {
    parse_ed25519(&env::promise_result_checked(index, MAX_KEY_LEN).ok()?)
}

fn derive_key(signer: &AccountId, path: &str, vault: &AccountId, domain_id: u32) -> Promise {
    let args = json!({ "path": path, "predecessor": vault, "domain_id": domain_id });
    Promise::new(signer.clone()).function_call(
        "derived_public_key",
        args.to_string().into_bytes(),
        NearToken::from_yoctonear(0),
        KEY_GAS,
    )
}

#[near]
impl CovenantFactory {
    /// `vault_code_hash` is the global contract every vault runs. There's no method to change it,
    /// so a new vault version means a new factory.
    #[init]
    pub fn new(signer: AccountId, vault_code_hash: near_sdk::json_types::Base58CryptoHash) -> Self {
        Self {
            signer,
            vault_code_hash: vault_code_hash.into(),
            vaults: LookupMap::new(b"v"),
        }
    }

    /// Creates `<name>.<factory>`, with the caller as owner. Everything attached but the registry
    /// fee becomes the vault's balance, and all of it comes back if the vault can't be created.
    #[payable]
    pub fn create_vault(
        &mut self,
        name: String,
        agent: AccountId,
        guardian: Option<AccountId>,
        policy: Policy,
    ) -> Promise {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        if deposit < MIN_DEPOSIT {
            env::panic_str("create_vault: attach at least 1.1 NEAR");
        }
        if env::prepaid_gas() < MIN_GAS {
            env::panic_str("create_vault: attach at least 200 Tgas");
        }
        if name.is_empty() || name.contains('.') {
            env::panic_str("create_vault: name must be one label, with no dots");
        }
        let vault: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("create_vault: not a valid account name"));
        // The agent is the party the vault guards against, so it can't hold a role that controls it.
        if agent == owner || guardian.as_ref() == Some(&agent) {
            env::panic_str("create_vault: the agent can't also be the owner or guardian");
        }
        if let Err(reason) = policy.validate() {
            env::panic_str(reason);
        }
        derive_key(&self.signer, BTC_PATH, &vault, SECP256K1_DOMAIN)
            .and(derive_key(&self.signer, EVM_PATH, &vault, SECP256K1_DOMAIN))
            .and(derive_key(&self.signer, SOL_PATH, &vault, ED25519_DOMAIN))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_KEYS_GAS)
                    .on_keys(vault, owner, agent, guardian, policy, deposit),
            )
    }

    /// Never panics once the keys are in: a panic here would keep the caller's deposit.
    #[private]
    pub fn on_keys(
        &mut self,
        vault: AccountId,
        owner: AccountId,
        agent: AccountId,
        guardian: Option<AccountId>,
        policy: Policy,
        deposit: NearToken,
    ) -> PromiseOrValue<bool> {
        let (Some(btc), Some(evm), Some(sol)) = (key_result(0), key_result(1), ed25519_result(2))
        else {
            return refund(vault, owner, deposit, "the signer gave no key");
        };
        let args = json!({
            "owner": owner,
            "guardian": guardian,
            "agent": agent,
            "signer": self.signer,
            "paths": { "btc": BTC_PATH, "evm": EVM_PATH, "sol": SOL_PATH },
            "btc_pubkey": Base64VecU8(compressed(&btc).to_vec()),
            "evm_address": evm_address(&evm),
            "sol_pubkey": sol,
            "policy": policy,
        });
        let balance = deposit.saturating_sub(REGISTRY_FEE);
        // One batch, so the account can't exist without its code and its owner.
        Promise::new(vault.clone())
            .create_account()
            .transfer(balance)
            .use_global_contract(self.vault_code_hash)
            .function_call(
                "new",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                NEW_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_CREATED_GAS)
                    .on_created(vault, owner, agent, deposit),
            )
            .into()
    }

    #[private]
    pub fn on_created(
        &mut self,
        vault: AccountId,
        owner: AccountId,
        agent: AccountId,
        deposit: NearToken,
    ) -> PromiseOrValue<bool> {
        if env::promise_result_checked(0, 0).is_err() {
            return refund(vault, owner, deposit, "the account couldn't be created");
        }
        self.vaults
            .entry(owner.clone())
            .or_default()
            .push(vault.clone());
        FactoryEvent::VaultCreated {
            vault,
            owner,
            agent,
        }
        .emit();
        PromiseOrValue::Value(true)
    }

    /// The vaults this account created, oldest first.
    pub fn vaults_of(&self, owner: AccountId) -> Vec<AccountId> {
        self.vaults.get(&owner).cloned().unwrap_or_default()
    }

    /// What every vault here runs, so anyone can compare it with the account's code.
    pub fn get_vault_code_hash(&self) -> near_sdk::json_types::Base58CryptoHash {
        self.vault_code_hash.into()
    }

    pub fn get_signer(&self) -> AccountId {
        self.signer.clone()
    }
}

fn refund(
    vault: AccountId,
    owner: AccountId,
    deposit: NearToken,
    reason: &str,
) -> PromiseOrValue<bool> {
    FactoryEvent::VaultNotCreated {
        vault,
        owner: owner.clone(),
        reason: reason.to_string(),
    }
    .emit();
    Promise::new(owner).transfer(deposit).detach();
    PromiseOrValue::Value(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    /// Secret key 1: the generator point, whose addresses are published test vectors.
    const X: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const Y: &str = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

    fn point() -> [u8; 64] {
        hex::decode(format!("{X}{Y}")).unwrap().try_into().unwrap()
    }

    fn factory() -> CovenantFactory {
        CovenantFactory::new(
            "signer.testnet".parse().unwrap(),
            "11111111111111111111111111111111".parse().unwrap(),
        )
    }

    fn policy() -> Policy {
        serde_json::from_value(json!({
            "caps": [],
            "payees": [],
            "btc_max_fee_rate": 50,
            "btc_max_inputs": 3,
            "evm_chain_ids": [84532],
            "evm_max_gas_cost": "1",
            "veto_delay_ns": 1u64,
        }))
        .unwrap()
    }

    fn context(deposit: NearToken, gas: Gas) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(0))
            .current_account_id("vaults.testnet".parse().unwrap())
            .attached_deposit(deposit)
            .prepaid_gas(gas)
            .build());
    }

    fn enough() {
        context(MIN_DEPOSIT, Gas::from_tgas(300));
    }

    #[test]
    fn derives_the_published_addresses_for_a_known_key() {
        assert_eq!(
            hex::encode(compressed(&point())),
            format!("02{X}"),
            "an even y compresses with 02"
        );
        assert_eq!(
            hex::encode(evm_address(&point())),
            "7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn compresses_an_odd_y_with_03() {
        let mut odd = point();
        odd[63] |= 1;
        assert_eq!(compressed(&odd)[0], 0x03);
    }

    #[test]
    fn reads_the_signers_answer_and_nothing_else() {
        let key = format!(
            "secp256k1:{}",
            near_sdk::bs58::encode(point()).into_string()
        );
        let answer = serde_json::to_vec(&key).unwrap();
        assert_eq!(parse_point(&answer), Some(point()));
        let ed25519 = serde_json::to_vec("ed25519:DHYDwovVbWb7Fhjm7HghjHmuMh5ZgYTtF1qJWWZ1YaEj");
        assert_eq!(parse_point(&ed25519.unwrap()), None);
        assert_eq!(parse_point(b"not json"), None);
    }

    /// The live signer's key for `covenant.len3hq.testnet` and `sol-vault-1`, read on 10 Nov.
    #[test]
    fn reads_the_solana_key_and_nothing_else() {
        let answer = serde_json::to_vec("ed25519:GnSDBdzbso6EgokmsndtcYbDdH7Vg3kczwf1Ro4mZA6T");
        let key = parse_ed25519(&answer.unwrap()).unwrap();
        assert_eq!(
            near_sdk::bs58::encode(key).into_string(),
            "GnSDBdzbso6EgokmsndtcYbDdH7Vg3kczwf1Ro4mZA6T"
        );
        let secp = format!(
            "secp256k1:{}",
            near_sdk::bs58::encode(point()).into_string()
        );
        assert_eq!(parse_ed25519(&serde_json::to_vec(&secp).unwrap()), None);
        assert_eq!(parse_ed25519(b"not json"), None);
    }

    #[test]
    #[should_panic(expected = "attach at least 1.1 NEAR")]
    fn refuses_a_deposit_too_small_for_a_vault() {
        context(NearToken::from_near(1), Gas::from_tgas(300));
        let _ = factory().create_vault("a".into(), accounts(1), None, policy());
    }

    #[test]
    #[should_panic(expected = "attach at least 200 Tgas")]
    fn refuses_too_little_gas_before_sending_anything() {
        context(MIN_DEPOSIT, Gas::from_tgas(100));
        let _ = factory().create_vault("a".into(), accounts(1), None, policy());
    }

    #[test]
    #[should_panic(expected = "no dots")]
    fn refuses_a_name_that_is_not_one_label() {
        enough();
        let _ = factory().create_vault("a.b".into(), accounts(1), None, policy());
    }

    #[test]
    #[should_panic(expected = "agent can't also be")]
    fn refuses_an_agent_that_is_also_the_owner() {
        enough();
        let _ = factory().create_vault("a".into(), accounts(0), None, policy());
    }

    #[test]
    #[should_panic(expected = "agent can't also be")]
    fn refuses_an_agent_that_is_also_the_guardian() {
        enough();
        let _ = factory().create_vault("a".into(), accounts(1), Some(accounts(1)), policy());
    }

    #[test]
    #[should_panic(expected = "every cap must be above zero")]
    fn refuses_a_policy_the_vault_would_refuse() {
        enough();
        let mut bad = policy();
        bad.caps = serde_json::from_value(
            json!([{ "asset": "Btc", "per_tx": "0", "per_24h": "1", "queue_at": "1" }]),
        )
        .unwrap();
        let _ = factory().create_vault("a".into(), accounts(1), None, bad);
    }
}

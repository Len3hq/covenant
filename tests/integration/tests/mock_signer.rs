use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Contract;
use serde_json::{json, Value};
use std::path::Path;

const WASM: &str = "../../target/near/covenant_mock_signer/covenant_mock_signer.wasm";
const PAYLOAD: &str = "89a73179c344b8d52a3205f42c1f7af2ffb18a91deb285976f3b55c040305a04";

async fn mock() -> anyhow::Result<Contract> {
    let wasm = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(WASM))
        .map_err(|e| anyhow::anyhow!("{WASM}: {e}. Run `make wasm` first."))?;
    Ok(near_workspaces::sandbox().await?.dev_deploy(&wasm).await?)
}

fn request() -> Value {
    json!({ "request": { "payload_v2": { "Ecdsa": PAYLOAD }, "path": "vault", "domain_id": 0 } })
}

#[tokio::test]
async fn mock_signer_matches_the_live_response_shape_and_checks() -> anyhow::Result<()> {
    let mock = mock().await?;

    let response: Value = mock
        .call("sign")
        .args_json(request())
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(response["scheme"], "Secp256k1");
    assert_eq!(response["s"]["scalar"], PAYLOAD);
    assert!(response["big_r"]["affine_point"].is_string());
    assert!(response["recovery_id"].is_u64());

    let no_deposit = mock
        .call("sign")
        .args_json(request())
        .gas(Gas::from_tgas(50))
        .transact();
    assert!(no_deposit.await?.into_result().is_err());

    let low_gas = mock
        .call("sign")
        .args_json(request())
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(10))
        .transact();
    assert!(low_gas.await?.into_result().is_err());

    mock.call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let failing = mock
        .call("sign")
        .args_json(request())
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact();
    assert!(failing.await?.into_result().is_err());

    assert_eq!(mock.view("get_calls").await?.json::<u64>()?, 1);
    Ok(())
}

/// The live Ed25519 shape, from the spike on 10 Nov, and the domain each payload must use.
#[tokio::test]
async fn mock_signer_signs_ed25519_only_in_its_domain() -> anyhow::Result<()> {
    let mock = mock().await?;
    let sign = |payload: Value, domain_id: u32| {
        mock.call("sign")
            .args_json(json!({ "request": { "payload_v2": payload, "path": "vault", "domain_id": domain_id } }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(50))
            .transact()
    };
    let message = "ab".repeat(200);
    let response: Value = sign(json!({ "Eddsa": message }), 1)
        .await?
        .into_result()?
        .json()?;
    assert_eq!(response["scheme"], "Ed25519");
    assert_eq!(response["signature"].as_array().unwrap().len(), 64);

    assert!(sign(json!({ "Eddsa": message }), 0)
        .await?
        .into_result()
        .is_err());
    assert!(sign(json!({ "Ecdsa": PAYLOAD }), 1)
        .await?
        .into_result()
        .is_err());
    assert!(sign(json!({ "Eddsa": "ab".repeat(31) }), 1)
        .await?
        .into_result()
        .is_err());
    assert!(sign(json!({ "Eddsa": "ab".repeat(1233) }), 1)
        .await?
        .into_result()
        .is_err());

    let key: String = mock
        .view("derived_public_key")
        .args_json(
            json!({ "path": "sol-vault-1", "predecessor": "vault.test.near", "domain_id": 1 }),
        )
        .await?
        .json()?;
    assert!(key.starts_with("ed25519:"), "{key}");
    Ok(())
}

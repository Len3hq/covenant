# Covenant key holder

The hosted connector's agent key lives here, inside an Intel TDX enclave that
[OutLayer](https://app.outlayer.ai/docs) runs. The key is derived in the enclave and only its public
key ever leaves. The design, including what it trusts, is in [docs/HOSTED.md](../../docs/HOSTED.md).

## What it does

- `{"operation": "public_key"}` answers `{"public_key": "ed25519:..."}`, the access key every hosted
  agent account carries.
- `{"operation": "sign_call", "call": <AgentCall>, "grant": <Grant>}` answers `{"signature": <base64>}`
  only if all of these hold:
  - the call is `propose_spend` or `execute`, with no deposit, for this key;
  - the grant is a NEP-413 message `covenant-hosted:v1 owner=… vault=… agent=… expires=…`, signed for
    the recipient `covenant-hosted`, not yet expired, naming the call's vault and agent;
  - the grant's key is a full-access key of the owner, and the vault's `get_roles` names that owner and
    agent. Both are read from NEAR testnet inside the enclave.

  It builds the transaction's bytes itself from the call's fields and signs their hash. It never signs
  bytes or a digest it was handed. `tests/vectors/agent_call.json` pins its encoding to near-api-js's.

The manifest admits HTTPS calls only, so no contract can start a run under the key.

## Build

```sh
make enclave   # prints the SHA256 that names the version on OutLayer
```

## Deploy (the project owner does this)

`outlayer login` asks for a full-access key of the project's owner account, so run these yourself:

```sh
curl -fsSL https://raw.githubusercontent.com/out-layer/outlayer-cli/main/install.sh | sh
outlayer login                       # mainnet; the account that owns the project
make enclave
outlayer upload hosted/enclave/target/wasm32-wasip2/release/covenant-key-holder.wasm
outlayer deploy covenant-key-holder <the FastFS URL upload printed>
```

Then check it answers, with the payment key from `.env`:

```sh
curl -s -X POST https://api.outlayer.ai/call/<owner>/covenant-key-holder \
  -H "X-Payment-Key: $OUTLAYER_PAYMENT_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"operation": "public_key"}}'
```

Expect `"status": "completed"` and an output with the public key. The key belongs to the project and
to the payment key's owner, so it stays the same across new versions, and a call with anyone else's
payment key gets a different key.

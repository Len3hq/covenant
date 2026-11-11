# Covenant hosted connector

The vault's MCP tools over HTTP, for Claude on the web, desktop and phone through Settings →
Connectors → Add custom connector. It holds no keys: each vault call is signed by the key holder in
OutLayer's enclave ([hosted/enclave](../enclave)), and only for a vault whose owner signed a grant.
The design is in [docs/HOSTED.md](../../docs/HOSTED.md).

## How signing in works

1. Claude registers itself and opens `/authorize`. The connector sends the owner to the dashboard
   with `?connect=<request>&connector=<this URL>`.
2. On the dashboard the owner connects their wallet, picks one of their hosted vaults and signs a
   grant: a NEP-413 message `covenant-hosted:v1 owner=… vault=… agent=… expires=…`.
3. The dashboard posts the grant to `/grant`. The connector checks it against NEAR (the key is the
   owner's, the vault names that owner and agent) and sends the browser back to Claude with a code.
4. Claude trades the code for an access token that carries the grant. Every `/mcp` request serves
   that one vault, and the enclave checks the grant again before each signature.

Client registrations and tokens are sealed with `CONNECTOR_SECRET`, so nothing is stored and a
restart signs nobody out. A token lasts as long as its grant.

## Settings

| Variable | |
| --- | --- |
| `PUBLIC_URL` | This service's public URL, such as `https://connector-production-xxxx.up.railway.app` |
| `DASHBOARD_URL` | The dashboard, such as `https://dashboard-production-65f1.up.railway.app/` |
| `CONNECTOR_SECRET` | 32 random bytes, hex: `openssl rand -hex 32`. Changing it signs everyone out |
| `OUTLAYER_PROJECT` | `keyholder.len3hq.testnet/covenant-key-holder` |
| `OUTLAYER_PAYMENT_KEY` | The OutLayer payment key that pays for each signature |
| `OUTLAYER_API_URL` | Defaults to OutLayer testnet, `https://testnet-api.outlayer.ai` |
| `NEAR_RPC_URL` | Defaults to FastNear's testnet RPC |
| `DATA_DIR` | Where each vault's spends file lives; a Railway volume at `/data` |
| `DEV_DASHBOARD_ORIGINS` | Extra dashboard origins that may hand over a grant, comma-separated, such as `http://localhost:5199` for a local dashboard |
| `LOCAL_AGENT_KEY` | Development only: sign in this process instead of the enclave |

## Run it locally

```sh
pnpm --filter @covenant/connector... build
PUBLIC_URL=http://localhost:8787 DASHBOARD_URL=http://localhost:5173/ \
  CONNECTOR_SECRET=$(openssl rand -hex 32) LOCAL_AGENT_KEY=<an ed25519 key that holds nothing> \
  node hosted/connector/dist/index.js
```

## Deploy

A Railway service named `connector`, built from the repo root with `hosted/connector/Dockerfile`,
with a volume at `/data` and the settings above.

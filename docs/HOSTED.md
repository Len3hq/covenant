# Hosted connector (design)

Status: live on testnet (11 Nov 2026).

- Key holder: OutLayer testnet project `keyholder.len3hq.testnet/covenant-key-holder`, version
  `db76a6636deb65f1c5899f117f3c63abe4fcf9266a2853b3cdfffa955a7c1460`. Its public key, the access key of
  every hosted agent, is `ed25519:8rPY7UqToQA4QTWpe7pWGTWT5aMxFbPcaRWuqStWY56z`.
- Connector: https://connector-production-d939451a.up.railway.app. Each hosted vault's connector URL
  is its own, `https://connector-production-d939451a.up.railway.app/v/<vault>/mcp`; the shared `/mcp`
  asks which vault at sign-in.

The parts:

- [sdk/src/signer.ts](../sdk/src/signer.ts): the SDK signs through a remote signer.
- [hosted/enclave](../hosted/enclave): the key holder, for OutLayer.
- [hosted/connector](../hosted/connector): the connector, with OAuth.
- The dashboard: "Hosted" on `?create`, the `?connect` sign-in page, and the enclave key marked on a
  vault's page. All three appear only when `VITE_CONNECTOR_URL` is set.

To publish a change: `make enclave` and the steps in hosted/enclave/README.md for the key holder,
`make deploy-connector` for the connector, `make deploy-dashboard` for the dashboard.

An opt-in way to use a vault from Claude on the web, desktop and phone, through Settings → Connectors
→ Add custom connector, with nothing to install. The self-hosted ways (the MCP server over `npx`, a
Claude Desktop extension, the SDK) stay the default.

## What changes and what doesn't

The vault contract doesn't change. It still enforces every rule: caps, payees, the veto window,
freeze. The only thing that moves is where the **agent key** lives: in an Intel TDX enclave run by
[OutLayer](https://app.outlayer.ai/docs), instead of on the user's machine. The owner key stays in the
owner's wallet in both modes.

| | Self-hosted | Hosted |
| --- | --- | --- |
| Agent key | On the user's machine | Derived inside an OutLayer TDX enclave; nobody can read it, including us |
| Who can ask the vault to pay | Whoever runs the user's agent | The connector, for vaults whose owner signed a grant |
| Works in | Claude Desktop, Claude Code, Cursor, scripts | Any client that adds a remote MCP server by URL |

## Parts

1. **Key holder**: a WASM component (`wasm32-wasip2`) deployed as an OutLayer project. It declares
   one ed25519 signing key in its `outlayer.manifest` (`bind: "project"`, so it survives upgrades).
   Its operations:
   - `public_key`: the key's public key, which becomes the hosted agent's NEAR access key.
   - `sign_call`: takes the fields of one NEAR transaction (signer, receiver, nonce, block hash,
     method, args) and a grant, checks them, builds the transaction's bytes itself, and returns the
     64-byte signature. It refuses any method but `propose_spend` and `execute`, any receiver the
     grant doesn't name, and an expired or unsigned grant. It never signs bytes it was handed.
2. **Connector**: a Node service on Railway, next to the dashboard. It serves the MCP tools over
   Streamable HTTP, runs the OAuth sign-in Claude's connectors use, and holds no keys. For a payment it
   prepares the chain transaction exactly as the SDK does today, then asks the key holder to sign the
   NEAR call through OutLayer's HTTPS API, and broadcasts the result.
3. **SDK**: `connectVault` takes a signer function instead of a raw key, so the connector reuses the
   SDK's payment code unchanged.
4. **Dashboard**: a third agent option on `?create`, "Hosted, for Claude on the web or phone". The
   owner's wallet creates the agent account with the key holder's public key, so no secret exists
   anywhere outside the enclave, then signs the grant. The vault page shows "Agent key held in an
   OutLayer enclave", the connector URL, and a button to revoke the grant.

## Held payments

A payment the vault holds for a veto goes through when its wait ends unless the owner vetoes it.
The connector makes that true with no one signed in: it keeps each vault's newest grant on its
volume, and every 30 seconds sends the held payments it made whose wait is over, through the
enclave. The vault checks each against its rules again, and the enclave checks the grant again.
`AUTO_EXECUTE=off` turns it off.

## Solana

A Solana payment held for a veto needs a durable nonce account the vault controls, so it can still
land after the wait. The connector creates two for each hosted vault the first time it's used,
paying their rent from `SOL_FUNDER_KEY`; their authority is the vault's own Solana address, so the
funder has no power over them. The vault still needs a little SOL of its own for fees.

## Grants

The connector would otherwise be able to drive the agent key of every hosted vault. A grant limits
that. It is a NEP-413 message the vault's owner signs with their wallet:

```
covenant-hosted:v1 vault=<vault> agent=<agent> expires=<unix seconds>
```

The key holder checks the signature against a full-access key of the owner's account (read over NEAR
RPC from inside the enclave), that the vault's `get_roles` names this owner and agent, and that the
grant hasn't expired. Without a valid grant it signs nothing. The owner can end a grant early by
replacing the agent or freezing the vault, as today.

## Trust, stated plainly

- Nobody, including us, can read or copy the agent key. OutLayer's attestation shows the exact WASM
  that holds it.
- Whoever holds Covenant's OutLayer payment key can ask the enclave to sign `propose_spend` for a vault
  with a live grant. The contract still applies that vault's rules, so the worst case is payments to
  listed payees up to the owner's caps, plus queued payments the owner can veto.
- Hosted vaults should default to stricter rules: new payees held, lower caps. Not built yet: today a
  hosted vault takes the same form as any other.
- On mainnet this may count as custody in some places. Testnet only for now.

## Open points

1. **One key or one per user.** OutLayer derives a key from the project, the path and the caller, and
   the caller over HTTPS is the payment key's owner. With one payment key, every hosted agent account
   carries the same public key. Each account's key can still only call its own vault, but one key
   serves them all. A key per user would need a payment key per user. The grant is what keeps one
   vault's owner from driving another's, so one shared key is the proposal.
2. **Network.** The key holder runs on OutLayer testnet as `keyholder.len3hq.testnet`, paid in its
   free test USDC, like the vaults on NEAR testnet. Mainnet would need a mainnet project and real USDC.
3. **Deploying.** `outlayer login` needs a full-access key for the project's owner account.

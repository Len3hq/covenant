# Scripts

Run these through the Makefile, which loads `.env`. `make help` lists every target.

| Command | Script | Purpose |
| --- | --- | --- |
| `make addresses` | `src/derive-addresses.ts` | Print the vault's Bitcoin and EVM addresses |
| `make deploy` | `src/deploy.ts` | Deploy the vault, initializing it on first deploy with `policy.testnet.json` |
| `make deploy-factory` | `src/deploy-factory.ts` | Publish the vault code as a global contract and deploy the factory |
| `make set-policy` | `src/set-policy.ts` | Apply a policy to the deployed vault, as its owner |
| `make agent-key` | `src/create-agent-key.ts` | Create the agent's key, limited to `propose_spend` and `execute` |
| `make sol-nonce` | `src/create-nonce.ts` | Create a durable nonce account the vault's Solana payments advance |
| `make veto`, `make freeze`, `make unfreeze`, `make set-guardian` | `src/admin.ts` | Owner and guardian actions |
| `make dao-veto`, `make dao-freeze` | `src/dao.ts` | Veto or freeze by a Sputnik DAO vote |
| `pnpm --filter @covenant/scripts vectors` | `src/generate-vectors.ts` | Regenerate the test vectors in `tests/vectors` |

`policy.testnet.json` is the live demo vault's policy: four payees on Bitcoin, Base and Solana, its caps
and its veto windows.

A contract state change can make a redeploy incompatible with stored state. If so, delete and
recreate the account: the vault addresses stay the same as long as the name and paths do.

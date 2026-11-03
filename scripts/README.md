# Scripts

Run these through the Makefile, which loads `.env`.

| Command | Script | Purpose |
| --- | --- | --- |
| `make addresses` | `src/derive-addresses.ts` | Print the vault's Bitcoin and EVM addresses |
| `make deploy` | `src/deploy.ts` | Deploy the vault, initializing it on first deploy with `policy.testnet.json` |

`policy.testnet.json` has no payees yet, so it refuses every payment until they're added at M7.
A contract state change can make a redeploy incompatible with stored state. If so, delete and
recreate the account: the vault addresses stay the same as long as the name and paths do.

`fund` and `record-evidence` are still to come (M10).

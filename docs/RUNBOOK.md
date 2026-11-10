# Runbook: deploy and test on testnet

For whoever holds the vault, owner and factory keys. It deploys the work in
[NEXT_PHASES.md](NEXT_PHASES.md) and checks each phase on testnet. Work top to bottom; each phase
says what to run, what you should see, and what to send back. Updated as phases are built.

| Phase | Built | Deployed | Tested live |
| --- | --- | --- | --- |
| 1. Pay anyone, hold new payees for veto | Yes | No | No |
| 2. Pay on any chain through Tidepool | Yes | No | No |
| 3. Create and replace the agent from the dashboard | Yes | No | No |
| 4. "Create agent key" button | Yes | No | No |
| 5. MCP server on npm | No | | |
| 6. Ready-made settings snippet | No | | |

When a step fails, stop, and send the command, its full output, and the NEAR transaction link if
there is one.

## 0. Before you start

You need:

- **Tools:** Rust (via rustup), Node 22, pnpm 11, the [NEAR CLI](https://github.com/near/near-cli-rs)
  and gitleaks.
- **A `.env`** filled in from `.env.example`. `USDC_ADDRESS` must be Tidepool's test USDC,
  `0x38d81431B9f76d9699AF7517040D5221D9dEA252`.
- **Keys the NEAR CLI can sign with,** from its legacy keychain
  (`~/.near-credentials/testnet/<account>.json`):

  | Account | Key | Used for |
  | --- | --- | --- |
  | `covenant.len3hq.testnet` | Full access | Upgrading the vault's code |
  | `owner.len3hq.testnet` | Full access | `set_policy`, `veto`, `set_agent` |
  | A new factory account, such as `vaults-v3.len3hq.testnet` | Full access | Deploying the new factory |
  | `FACTORY_PUBLISHER_ACCOUNT_ID` | Full access | Publishing the vault code (about 40 NEAR, up from 29, because the code is now 384 KB) |
  | `agent.len3hq.testnet` | The function-call key in `AGENT_PRIVATE_KEY` | The live payments below |

Check out the code and run every test:

```sh
git pull
make setup
make check        # every test, then gitleaks on the full history; all must pass
make demo         # the three keyless scenarios on a local sandbox; all must PASS
```

Then check that the vault's queue is empty, because the upgrade refuses to run otherwise:

```sh
near contract call-function as-read-only covenant.len3hq.testnet get_queue json-args '{}' network-config testnet now
```

Expect `[]`. If not, veto each spend first with `make veto ID=<id>`.

## 1. Upgrade the live vault (phases 1 to 4 in the contract)

```sh
make deploy
```

`make deploy` sees that the vault runs the code from before open payees, and deploys and calls
`migrate_v3` in one transaction. Check the result:

```sh
near contract call-function as-read-only covenant.len3hq.testnet get_policy json-args '{}' network-config testnet now
```

You should see `"unlisted": "Refuse"`, `"swap": null` and every `unlisted_per_24h` at `"0"`. The
vault behaves exactly as before until step 2.

**Send back:** the deploy transaction link.

## 2. Apply the new policy

The policy file now uses Tidepool's test USDC on Base and Solana, and turns swaps on.

```sh
make set-policy
near contract call-function as-read-only covenant.len3hq.testnet get_policy json-args '{}' network-config testnet now
```

Expect a `swap` section with `maker_key`, 4 `origins` and 22 `destinations`. The USDC cap should
use token `0x38d8…a252`.

**Send back:** the `set_policy` transaction link.

## 3. Fund the vault

Get the vault's addresses with `make addresses`. Then:

- **Tidepool test USDC and USDT** on Base and Solana. Tidepool allows one claim per address each
  week:

  ```sh
  curl -s -X POST https://www.usetidepool.tech/v0/faucet -H 'content-type: application/json' \
    -d '{"chain":"base","address":"<vault Base address>"}'
  curl -s -X POST https://www.usetidepool.tech/v0/faucet -H 'content-type: application/json' \
    -d '{"chain":"sol","address":"<vault Solana address>"}'
  ```

  Base drips need an address with some Ethereum Sepolia history. If Tidepool answers 403 for the
  vault, drip to your own Ethereum Sepolia address and send the USDC on.
- **testnet4 BTC:** [CypherFaucet](https://cypherfaucet.com/btc-testnet) or
  [testnet4.info](https://testnet4.info).
- **Base Sepolia ETH, for gas:** one of the faucets on
  [Base's list](https://docs.base.org/get-started/get-funds).
- **Devnet SOL:** [faucet.solana.com](https://faucet.solana.com).

The dashboard's "Get test funds" panel does the same once step 6 is done.

## 4. Phase 1: payees off the list

**4a. Refuse mode, the default:**

```sh
make pay-btc TO=<a testnet4 address NOT on the payee list> SATS=10000
```

Expect `Rejected` with `OutputNotWhitelisted`, and nothing signed.

**4b. Hold mode.** This switches to the open policy, with a 10-minute window for new payees and a
fifth of each daily cap for them:

```sh
make set-policy POLICY=scripts/policy.open.testnet.json
make pay-btc TO=<the same address> SATS=10000
```

Expect `Queued`, with `executable_at` about 10 minutes away, even though 10,000 sats is under the
normal veto threshold. Then:

```sh
make veto ID=<the id it printed>
```

Expect the veto to succeed. `get_unlisted_spent_24h` for `"Btc"` should go back to `"0"`:

```sh
near contract call-function as-read-only covenant.len3hq.testnet get_unlisted_spent_24h json-args '{"asset":"Btc"}' network-config testnet now
```

Leave the open policy on for phase 2.

**Send back:** the three transaction links: the refusal, the queued spend and the veto.

## 5. Phase 2: pay on another chain through Tidepool

These use `make pay-swap`, which follows Tidepool's status for up to 10 minutes. The recipient isn't
on the swap payee list, so with the open policy each payment is held for 10 minutes first.

**5a. BTC to USDC on Solana:**

```sh
make pay-swap ASSET=BTC AMOUNT=20000 TO_CHAIN=solana TO_ASSET=USDC TO=<a Solana devnet address> REF=swap-test-1
```

Expect `queued`. After 10 minutes:

```sh
make execute ID=<the id it printed>
```

Expect `broadcast`, then Tidepool moving from `PENDING_DEPOSIT` to `PROCESSING` to `SUCCESS`. The
Bitcoin deposit needs one confirmation, so this takes 10 to 30 minutes. Check later by running the
same `make pay-swap` command again, which never pays a reference twice, or with the MCP tool
`get_payment_status`.

**5b. USDC on Base to USDC on Solana:**

```sh
make pay-swap ASSET=USDC AMOUNT=5000000 TO_CHAIN=solana TO_ASSET=USDC TO=<a Solana devnet address> REF=swap-test-2
```

Same steps. This one settles in about a minute once executed.

**5c. A refused swap:**

```sh
make pay-swap ASSET=BTC AMOUNT=20000 TO_CHAIN=near TO_ASSET=wNEAR TO=you.testnet REF=swap-test-3
```

Expect `SwapAssetNotAllowed` or an SDK error naming the token, because NEAR-native tokens aren't on
the policy's destination list.

Then restore the normal policy:

```sh
make set-policy
```

**Limits to know:**

- **Per swap on Tidepool:** BTC 10,000 to 500,000 sats, at most 0.005 SOL paid out, and at most
  0.006 ETH.
- **Coins the vault can swap from:** only BTC, ETH, USDC on Base, and SOL.

**Send back:** for each swap, the NEAR transaction link, the chain transaction link, and the final
Tidepool status.

## 6. New factory and dashboard (needed for phases 3 and 4)

The old factory, `vaults.len3hq.testnet`, can never change its code. Create a new factory account,
set `FACTORY_ACCOUNT_ID` and `FACTORY_PUBLISHER_ACCOUNT_ID` in `.env`, then:

```sh
make deploy-factory
near contract call-function as-read-only <new factory> get_vault_code_hash json-args '{}' network-config testnet now
```

Point the dashboard at the new factory and publish it:

```sh
railway variables --service dashboard --set VITE_FACTORY_ACCOUNT_ID=<new factory>
make deploy-dashboard
```

Open https://dashboard-production-65f1.up.railway.app/?create and check that the hint under "Vault
name" ends in the new factory.

**Send back:** the factory account, the code hash, and the publish and deploy transaction links.

## 7. Phase 3: create the agent from the dashboard

Use a fresh testnet account of your own, not the live owner, with about 3 NEAR.

1. Open `?create` and connect the wallet.
2. Leave "Create one for me" ticked, keep the agent name `agent`, and fill in a vault name. Leave
   swaps ticked.
3. Press create. Expect two wallet prompts: one creating `agent.<you>.testnet`, then one creating
   the vault.
4. Save the key it shows. Check the agent's keys:

   ```sh
   near account list-keys agent.<you>.testnet network-config testnet now
   ```

   Expect exactly one key, a function-call key for `<vault>` with methods `propose_spend` and
   `execute`, and no full-access key.
5. Make a payment with that key. Put the new vault, agent and key in a copy of `.env`, fund the
   vault (step 3), and run `make pay-btc` to a payee you listed.
6. On the new vault's page, still as the owner, press **Replace agent** with the name `agent2`.
   Expect two prompts, a new key to save, and the "Who can do what" card showing
   `agent2.<you>.testnet`. The old key's next `make pay-btc` must fail with `NotAgent`.

Try steps 1 to 3 with every wallet you can, such as MyNearWallet, Meteor, HOT and Intear. Note any
that refuse the account-creation transaction.

**Send back:**

- for each wallet, whether creation worked;
- the `list-keys` output;
- the payment's transaction link;
- the `set_agent` transaction link and the `NotAgent` failure.

## 8. Phase 4: "Create agent key"

This needs an agent account whose full-access key is in a wallet.

1. Create a vault on `?create` with "Use one I already have", naming an account of yours.
2. Open the vault's page and connect that agent account's wallet. The **Agent keys** card should say
   it has no key for this vault, and offer **Create agent key**.
3. Press it, approve, and save the key. The card should list one key with 1 NEAR of gas.
4. Make a payment with it, as in step 7.5.
5. Press **Remove** on that key, approve, and check that the next payment with it fails.

**Send back:** the `list-keys` output after steps 3 and 5, and the payment's transaction link.

## 9. Record the evidence

Add each transaction link to [EVIDENCE.md](../EVIDENCE.md), under a heading per phase, in the format
already there. Then tick "Deployed" and "Tested live" in the table at the top of this file.

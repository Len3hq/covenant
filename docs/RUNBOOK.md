# Runbook: deploy and test on testnet

For whoever holds the vault, owner and factory keys. It deploys the work in
[NEXT_PHASES.md](NEXT_PHASES.md), then runs every live test, numbered T1 to T45. Work top to bottom:
later tests rely on earlier steps. Each test says what to run and what you should see; fill in the
[results table](#results) as you go. Updated as phases are built.

| Phase | Built | Deployed | Tested live |
| --- | --- | --- | --- |
| 1. Pay anyone, hold new payees for veto | Yes | No | No |
| 2. Pay on any chain through Tidepool | Yes | No | No |
| 3. Create and replace the agent from the dashboard | Yes | No | No |
| 4. "Create agent key" button | Yes | No | No |
| 5. SDK and MCP server on npm | Yes | No | No |
| 6. Ready-made settings snippet | Yes | No | No |

When a test fails, stop. Send the test number, the command, its full output, and the NEAR
transaction link if there is one. Everything here is testnet, so the coins have no value.

## 0. Before you start

You need:

- **Tools:** Rust (via rustup), Node 22, pnpm 11, the [NEAR CLI](https://github.com/near/near-cli-rs),
  gitleaks, and the Railway CLI, logged in.
- **A `.env`** filled in from `.env.example`. `USDC_ADDRESS` must be Tidepool's test USDC,
  `0x38d81431B9f76d9699AF7517040D5221D9dEA252`.
- **Keys the NEAR CLI can sign with,** from its legacy keychain
  (`~/.near-credentials/testnet/<account>.json`):

  | Account | Key | Used for |
  | --- | --- | --- |
  | `covenant.len3hq.testnet` | Full access | Upgrading the vault's code |
  | `owner.len3hq.testnet` | Full access | `set_policy`, `veto`, `freeze`, `unfreeze`, `set_agent` |
  | The guardian DAO's council member (`GUARDIAN_ACCOUNT_ID`) | Full access | The DAO veto and freeze tests |
  | A new factory account, such as `vaults-v3.len3hq.testnet` | Full access | Deploying the new factory |
  | `FACTORY_PUBLISHER_ACCOUNT_ID` | Full access | Publishing the vault code (about 40 NEAR, up from 29, because the code is now 384 KB) |
  | `agent.len3hq.testnet` | The function-call key in `AGENT_PRIVATE_KEY` | Every live payment |

- **A browser wallet**, such as MyNearWallet, Meteor, HOT or Intear, with a spare testnet account
  holding about 5 NEAR, for the dashboard tests. Use a spare account, not the live owner.
- **For T42:** an npm account that can create the `len3hq` org, and access to the repository's
  secrets.

**T1. Every offline test passes.**

```sh
git pull
make setup
make check        # every Rust, sandbox and TypeScript test, then gitleaks on the full history
make demo         # the three keyless scenarios on a local sandbox
node scripts/pack-smoke.mjs
```

Expect:

- `make check` to end with no failures, and gitleaks to report no leaks;
- `make demo` to print `PASS` three times;
- the pack check to list 9 tools.

**T2. The vault is ready to upgrade.**

```sh
near contract call-function as-read-only covenant.len3hq.testnet get_queue json-args '{}' network-config testnet now
```

Expect `[]`, because the upgrade refuses to run while any spend is queued. If it isn't empty, veto
each spend with `make veto ID=<id>`.

## 1. Deploy

**T3. Upgrade the live vault.**

```sh
make deploy
near contract call-function as-read-only covenant.len3hq.testnet get_policy json-args '{}' network-config testnet now
```

`make deploy` sees that the vault runs the code from before open payees, and deploys and calls
`migrate_v3` in one transaction. Expect the policy to show:

- `"unlisted": "Refuse"`;
- `"swap": null`;
- every `unlisted_per_24h` at `"0"`.

The vault behaves exactly as before until T4.

**T4. Apply the new policy.**

```sh
make set-policy
near contract call-function as-read-only covenant.len3hq.testnet get_policy json-args '{}' network-config testnet now
```

Expect a `swap` section with a `maker_key`, 4 `origins` and 22 `destinations`, and the USDC cap on
token `0x38d8…a252`.

**T5. Fund the vault.** Get its addresses with `make addresses`, then:

- **Tidepool test USDC and USDT** on Base and Solana, from
  [app.usetidepool.tech/faucet](https://app.usetidepool.tech/faucet). Tidepool turned off its faucet
  API, which now answers `403 site_only`, and allows one claim per address each week. Paste the
  vault's Base address (`0x…`) into the Base box and its Solana address into the Solana box.
- **testnet4 BTC:** [CypherFaucet](https://cypherfaucet.com/btc-testnet) or
  [testnet4.info](https://testnet4.info). About 0.006 BTC, because T15 holds 450,000 sats.
- **Base Sepolia ETH, for gas:** one of the faucets on
  [Base's list](https://docs.base.org/get-started/get-funds). About 0.01 ETH.
- **Devnet SOL:** [faucet.solana.com](https://faucet.solana.com). About 0.5 SOL.
- **The Solana payee's Tidepool USDC account,** which T9 pays into. Claim on the faucet page with
  the listed Solana payee's wallet, `xR99hjGSXQVvAWCPFfg8ZjqeLeWn9KVcX6X3N1iFHRU`, which creates
  that account. The policy lists it as `JCWcfRmxdV4i7R88kmo9U7VqSEsgQ9GrJFGmzEiDSqkD`.

Expect each balance on the dashboard's Budgets card.

## 2. Nothing that worked before is broken

These run the existing live checks against the upgraded vault, with the normal policy from T4.

**T6. Live smoke test.**

```sh
make testnet-smoke
```

It pays tiny amounts on Bitcoin and Base, including 1 base unit of Tidepool USDC, and checks a live
refusal. Expect it to exit 0.

**T7. The three scenarios, live, with the saved tool calls.**

```sh
make demo LIVE=1
```

Expect `PASS` three times. The queue scenario leaves one spend queued; veto it from the dashboard or
with `make veto ID=<id>`.

**T8. The attack scenario with a real model.** Needs the `LLM_*` settings.

```sh
make demo-attack LIVE=1 LLM=1
```

Expect `PASS` with no attacker paid. A real model may see through the poisoned invoice and never try
the attack; the run then passes and says so, because T7 already shows the contract refusing both
attacks. If the model does try, expect each attempt refused with `OutputNotWhitelisted` or
`CalldataNotAllowed`.

**T9. A Solana payment.** Needs `SOL_NONCE_ACCOUNTS`; run `make sol-nonce` once if it's empty.

```sh
make pay-sol TO=<the listed Solana payee> AMOUNT=1000
make pay-sol TO=<the listed Solana payee> AMOUNT=1000 TOKEN=USDC
```

Expect both to be broadcast. The USDC one now pays Tidepool's test USDC, to the payee's account for
that token, which the policy lists.

**T10. Freeze and unfreeze.**

```sh
make freeze
make pay-btc TO=<the listed Bitcoin payee> SATS=1000     # must fail with Frozen
make unfreeze
make pay-btc TO=<the listed Bitcoin payee> SATS=1000     # broadcast again
```

Expect the payment refused while frozen, and paid after unfreezing. The guardian is a DAO, so its
powers are tested in T11.

**T11. The guardian DAO.**

```sh
make demo-queue LIVE=1        # leaves a spend queued; note its id
make dao-veto ID=<id>
make dao-freeze
make unfreeze
```

Expect the DAO veto to remove the spend, and the DAO freeze to freeze the vault until the owner
unfreezes it.

## 3. Phase 1: payees off the list

**T12. Refuse mode refuses.**

```sh
make pay-btc TO=<a testnet4 address NOT on the payee list> SATS=10000
```

Expect `Rejected` with `OutputNotWhitelisted`, and nothing signed.

**T13. Hold mode holds even a small payment.** This switches to the open policy, which gives new
payees a 10-minute window and a fifth of each daily cap:

```sh
make set-policy POLICY=scripts/policy.open.testnet.json
make pay-btc TO=<the same address> SATS=10000
```

Expect `Queued`, with `executable_at` about 10 minutes away, although 10,000 sats is under the normal
veto threshold.

**T14. A veto returns the new-payee budget.**

```sh
near contract call-function as-read-only covenant.len3hq.testnet get_unlisted_spent_24h json-args '{"asset":"Btc"}' network-config testnet now
make veto ID=<the id from T13>
near contract call-function as-read-only covenant.len3hq.testnet get_unlisted_spent_24h json-args '{"asset":"Btc"}' network-config testnet now
```

Expect `"10000"` before the veto and `"0"` after.

**T15. The new-payee daily cap holds.** The open policy allows new payees 400,000 sats a day:

```sh
make pay-btc TO=<the same address> SATS=250000     # queued
make pay-btc TO=<the same address> SATS=200000     # must be refused: 450,000 > 400,000
```

Expect the second to be `Rejected` with `UnlistedCapExceeded`. Then veto the first.

**T16. A listed payee is still paid at once in hold mode.**

```sh
make pay-btc TO=<the listed Bitcoin payee> SATS=10000
```

Expect it to be broadcast, not queued.

Leave the open policy on for section 4.

## 4. Phase 2: pay on another chain through Tidepool

These use `make pay-swap`, which follows Tidepool's status for up to 10 minutes. The recipients
aren't swap payees, so with the open policy each swap is held for 10 minutes first, then finished
with `make execute`.

**T17. BTC to USDC on Solana.**

```sh
make pay-swap ASSET=BTC AMOUNT=20000 TO_CHAIN=solana TO_ASSET=USDC TO=<a Solana devnet address> REF=swap-t17
# after 10 minutes:
make execute ID=<the id it printed>
```

Expect `queued`, then `broadcast`, then Tidepool moving from `PENDING_DEPOSIT` through `PROCESSING`
to `SUCCESS`. The Bitcoin deposit needs one confirmation, so this takes 10 to 30 minutes. Run the
same `make pay-swap` command again to check: a reference never pays twice.

**T18. USDC on Base to USDC on Solana.**

```sh
make pay-swap ASSET=USDC AMOUNT=5000000 TO_CHAIN=solana TO_ASSET=USDC TO=<a Solana devnet address> REF=swap-t18
make execute ID=<id>          # after 10 minutes
```

Expect `SUCCESS` about a minute after it's executed.

**T19. ETH on Base to USDC on Arbitrum.** Start it after T18 is executed. The SDK refuses a second
Base payment while one is unfinished, because both would get the same nonce and the second could
never land.

```sh
make pay-swap ASSET=ETH AMOUNT=2000000000000000 TO_CHAIN=arbitrum TO_ASSET=USDC TO=<an EVM address> REF=swap-t19
make execute ID=<id>
```

Expect `SUCCESS`. Tidepool takes at most 0.006 ETH per swap.

**T20. A destination the policy doesn't list is refused.**

```sh
make pay-swap ASSET=BTC AMOUNT=20000 TO_CHAIN=near TO_ASSET=wNEAR TO=you.testnet REF=swap-t20
```

Expect `SwapAssetNotAllowed`, or an SDK error naming the token, with nothing signed.

**T21. Over Tidepool's own limit is refused before NEAR.**

```sh
make pay-swap ASSET=BTC AMOUNT=600000 TO_CHAIN=solana TO_ASSET=USDC TO=<a Solana devnet address> REF=swap-t21
```

Expect an error from Tidepool about its 500,000-sat cap, and no NEAR transaction.

**T22. A swap to a listed swap payee isn't held.** Add your Solana address to `swap.payees` in a copy
of the open policy, for example:

```json
"payees": [{ "destination_asset": "nep141:sol-d48c1adc423a64867ac91ed2e1c0df76da323235.tp-omft.testnet", "recipient": "<your Solana address>", "label": "me" }]
```

Then:

```sh
make set-policy POLICY=<that copy>
make pay-swap ASSET=USDC AMOUNT=2000000 TO_CHAIN=solana TO_ASSET=USDC TO=<your Solana address> REF=swap-t22
```

Expect `broadcast` straight away, with no queue, then `SUCCESS`.

Then restore the normal policy:

```sh
make set-policy
```

## 5. New factory and dashboard (needed for sections 6 to 9)

**T23. Deploy the new factory.** The old factory, `vaults.len3hq.testnet`, can never change its code.
Create a new factory account, set `FACTORY_ACCOUNT_ID` and `FACTORY_PUBLISHER_ACCOUNT_ID` in `.env`,
then:

```sh
make deploy-factory
near contract call-function as-read-only <new factory> get_vault_code_hash json-args '{}' network-config testnet now
```

Expect the code hash it prints to match the one `make deploy-factory` published.

**T24. Publish the dashboard against it.**

```sh
railway variables --service dashboard --set VITE_FACTORY_ACCOUNT_ID=<new factory>
make deploy-dashboard
```

Open https://dashboard-production-65f1.up.railway.app/?create. Expect the hint under "Vault name" to
end in the new factory.

**T25. The live vault's page shows the new parts.** Open the dashboard with no `?vault`, which shows
the live vault. Expect:

- the "Agent keys" card listing `agent.len3hq.testnet`'s key for the vault;
- the "Get test funds" panel;
- the swaps from section 4 in the decision log, with "Swapped through Tidepool" lines;
- the rules card reading the live policy.

**T26. The faucet buttons work.** Come back to this after T27, on the new vault, which hasn't
claimed this week. Press "Send test USDC to the vault on Solana". Expect "Sent 100 test USDC and 100 test USDT",
and the balance to appear within a minute. A second press should show Tidepool's weekly-limit
message.

## 6. Phase 3: create and replace the agent from the dashboard

**T27. Create a vault with a new agent.**

1. Connect the spare wallet on `?create`.
2. Leave "Create one for me" ticked, with the agent name `agent`.
3. Fill in a vault name, list one Bitcoin payee, and leave swaps ticked.
4. Press create.

Expect two wallet prompts, one creating `agent.<you>.testnet` and one creating the vault, then the
"is live" card with the settings panel from phase 6. Save the key.

**T28. The agent has exactly one key, scoped to the vault.**

```sh
near account list-keys agent.<you>.testnet network-config testnet now
```

Expect one function-call key for `<vault>`, with methods `propose_spend` and `execute` and a 1 NEAR
allowance, and no full-access key.

**T29. The new vault pays with that key.** Copy `.env` to `.env.t29`, set `VAULT_ACCOUNT_ID`,
`AGENT_ACCOUNT_ID` and `AGENT_PRIVATE_KEY` to the new vault's, fund it with a little BTC, then:

```sh
node --env-file=.env.t29 agent/dist/pay-btc.js <the listed payee> 10000
```

Expect `broadcast`. The new vault holds payees off the list by default, so a payment to any other
address should come back `Queued`.

**T30. A new vault allows swaps by default.**

```sh
near contract call-function as-read-only <new vault> get_policy json-args '{}' network-config testnet now
```

Expect a `swap` section, and `"unlisted": "Hold"`.

**T31. Replace the agent.** On the new vault's page, connected as its owner, enter `agent2` and
press **Replace agent**. Expect:

- two prompts;
- a new settings panel showing the new key;
- "Who can do what" showing `agent2.<you>.testnet`.

Then rerun the T29 payment with the old key. Expect it to fail with `NotAgent`.

**T32. A taken vault name stops before any prompt.** On `?create`, use a vault name that's already
taken. Expect a "taken" message before any wallet prompt, and no agent account created.

**T33. Every wallet.** Repeat T27 with each wallet you can, such as MyNearWallet, Meteor, HOT and
Intear. Note any that refuse the account-creation transaction.

## 7. Phase 4: "Create agent key"

**T34. Add a key to an existing agent.**

1. On `?create`, make a vault with "Use one I already have", naming a spare account whose
   full-access key is in your wallet.
2. Open the vault's page and connect that agent account. The Agent keys card should say it has no
   key for this vault, and offer **Create agent key**.
3. Press it and save the key.

Expect the card to list one key with 1 NEAR of gas, and `list-keys` to show it scoped to the vault.

**T35. The added key pays.** Make a payment with it, as in T29. Expect `broadcast`.

**T36. Remove the key.** Press **Remove** on that key. Expect it gone from `list-keys`, and the next
payment with it to fail.

**T37. Only the agent account sees the button.** Connect as the vault's owner. Expect no **Create agent
key**, and the hint to connect the agent's wallet instead.

## 8. Phase 6: the settings snippet

The panel appears after T27, T31 and T34.

**T38. Every tab is filled in.** Check each of Claude Desktop, Claude Code, Cursor and Your own code.
Expect the vault, agent and key in every one, and **Copy** and **Download .env** to work.

**T39. Claude Desktop connects from the snippet.** Paste the Claude Desktop tab into
`claude_desktop_config.json`, following its note, and restart Claude Desktop. Ask "what are my
vault's addresses?". Expect the new vault's three addresses.

Before T42, the snippet runs a local build: first run `pnpm --filter "@len3hq/covenant-mcp..." build`
in a clone, and replace `/path/to/covenant` in the snippet.

**T40. Claude Code connects from the snippet.** Run the Claude Code tab's command, then ask the same
question in Claude Code. Expect the same answer.

## 9. Phase 5: npm

**T41. Choose a license.** The repo has no LICENSE file, so the packages have no `license` field. Add
one and set `license` in `sdk/package.json` and `mcp/package.json` before publishing.

**T42. Publish.** One-time setup:

1. On npmjs.com, create the organization **len3hq**. A free org can publish public packages. The
   `@covenant` scope belongs to someone else.
2. Create a granular access token that can publish to `@len3hq`, and save it as a repository secret:

   ```sh
   gh secret set NPM_TOKEN --repo Len3hq/covenant
   ```

Then push a tag matching the version in both `sdk/package.json` and `mcp/package.json`:

```sh
git tag v0.1.0 && git push origin v0.1.0
gh run watch
```

Expect the Release workflow to:

1. run the tests;
2. pack and install both packages;
3. publish `@len3hq/covenant-sdk`, then `@len3hq/covenant-mcp`, each with npm provenance.

**T43. npx works from a clean machine.** Use any folder outside the repo, with only Node 22:

```sh
npx -y @len3hq/covenant-mcp --version
npx -y @len3hq/covenant-mcp --help
VAULT_ACCOUNT_ID=x.near AGENT_ACCOUNT_ID=a AGENT_PRIVATE_KEY=b npx -y @len3hq/covenant-mcp
```

Expect:

1. `0.1.0`;
2. the help text;
3. a refusal, because `x.near` isn't a testnet vault.

**T44. Switch the dashboard to npx.**

```sh
railway variables --service dashboard --set VITE_MCP_PUBLISHED=true
make deploy-dashboard
```

Expect the docs page (`?docs#mcp`) and the settings panel to show `npx -y @len3hq/covenant-mcp`,
with no build note.

**T45. An assistant pays through npx.** Point Claude Desktop at the live vault with the npx config:
`agent.len3hq.testnet` and `AGENT_PRIVATE_KEY`. Restart it, then ask, one at a time:

1. "Who can the vault pay?" Expect the payee list.
2. "Pay Acme Hosting 1000 sats for invoice T45-1." Expect `broadcast`, with a link.
3. "Pay 1000 sats to tb1qh2at4w46h2at4w46h2at4w46h2at4w46jvgsm3 for invoice T45-2." Expect
   `rejected` with `OutputNotWhitelisted`, because the live vault refuses payees off its list.
4. "What would 20000 sats of BTC buy in USDC on Solana?" Expect a `quote_payment` answer.
5. "Pay the same invoice T45-1 again." Expect the first result again, with no second payment.

Check that `~/.covenant/covenant.len3hq.testnet-spends.json` exists.

## 10. Record the evidence

Add each transaction link to [EVIDENCE.md](../EVIDENCE.md), under a heading per phase, in the format
already there. Tick "Deployed" and "Tested live" in the table at the top of this file, and commit both.

## Results

Copy this table into your reply, filling in each row.

| Test | Pass or fail | Links or notes |
| --- | --- | --- |
| T1 Offline tests | | |
| T2 Queue empty | | |
| T3 Vault upgraded | | |
| T4 Policy applied | | |
| T5 Vault funded | | |
| T6 Smoke test | | |
| T7 Live scenarios | | |
| T8 Real-model attack | | |
| T9 Solana payments | | |
| T10 Freeze and unfreeze | | |
| T11 DAO veto and freeze | | |
| T12 Refuse mode | | |
| T13 Hold mode | | |
| T14 Veto returns budget | | |
| T15 New-payee cap | | |
| T16 Listed payee in hold mode | | |
| T17 BTC to Solana USDC | | |
| T18 Base USDC to Solana USDC | | |
| T19 ETH to Arbitrum USDC | | |
| T20 Unlisted destination | | |
| T21 Over Tidepool's limit | | |
| T22 Listed swap payee | | |
| T23 New factory | | |
| T24 Dashboard published | | |
| T25 Live vault page | | |
| T26 Faucet buttons | | |
| T27 Vault with new agent | | |
| T28 Agent's one key | | |
| T29 New vault pays | | |
| T30 Swaps on by default | | |
| T31 Replace agent | | |
| T32 Taken vault name | | |
| T33 Wallets | | |
| T34 Create agent key | | |
| T35 Added key pays | | |
| T36 Remove key | | |
| T37 Button for agent only | | |
| T38 Snippet tabs | | |
| T39 Claude Desktop | | |
| T40 Claude Code | | |
| T41 License | | |
| T42 Published to npm | | |
| T43 npx | | |
| T44 Dashboard on npx | | |
| T45 Assistant pays | | |

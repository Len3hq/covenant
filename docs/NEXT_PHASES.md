# Next phases: open payees, cross-chain pay, one-click agent setup

This plan covers six changes and one optional extra:

1. Pay anyone, with unknown payees held for veto.
2. Pay on any chain in any token through Tidepool.
3. Create the agent's account from the dashboard.
4. Create the agent's key from the dashboard.
5. Publish the MCP server to npm.
6. Show a ready-made settings snippet.
7. Optional: TEE attestation.

Each phase lists what changes, where, the new errors, the tests, and the exit check.
[BUILD_PLAN.md](BUILD_PLAN.md) still holds the dates. The rules in [AGENTS.md](../AGENTS.md) still apply: all
security checks live in `contracts/`, unimplemented code fails closed, and the contract computes
every hash it signs.

Written 10 Nov 2026.

## Timing

The contract changes (phases 1 and 2, and `set_agent` in phase 3) must reach the live vault
**before the full-access key is removed on 13 Nov** (D6). After that, the live vault's code can't
change. Vaults made by the factory can't change either: a new factory with the new code hash is
needed, and old vaults stay on v1.

| Day | Work | Cut line if late |
| --- | --- | --- |
| Tue 10 to Wed 11 Nov | Phase 1 contract, `set_agent`, phase 2 contract | Phase 2 ships SDK-only as "preview", no contract support |
| Wed 11 to Thu 12 Nov | Phase 2 SDK and MCP, phases 3, 4 and 6 in the dashboard | Phase 6 can be a plain text block |
| Thu 12 Nov | Phase 5 (npm), redeploy the live vault and the new factory, record evidence | npm can slip to after submission |
| Fri 13 Nov | Fresh-clone test, video, remove the full-access key | Nothing new after this |
| Sat 14 Nov | Submit (the page says 23:59 UTC, the plan says 20:00 UTC; use 20:00) | |

Phase 7 (TEE) is after the hackathon, apart from the small 7B if time allows.

---

## Phase 1: pay anyone, hold unknown payees for veto

**Status: built on 10 Nov, not yet deployed.** It differs from the design below in three ways:

- **`Payment` is unchanged, with no `listed` field.** The policy decides who is listed
  (`Policy::is_listed`), so the adapters only ask `Policy::allows_payee`. Events and the SDK's
  decoders keep their shape.
- **The window isn't stored on the queued spend.** `Pending` stores the unlisted charges, and the
  window comes from today's policy at `execute`.
- **The migration has its own name.** It's `migrate_v3`, from the Solana-era state, and
  `make deploy` picks it on its own. The new dashboard form needs a factory with the new code
  hash, because older factory vaults ignore the new fields and keep refusing unlisted payees.

### Why not just delete the payee list

The list is what refused the real attack in [EVIDENCE.md](../EVIDENCE.md)
(`OutputNotWhitelisted`). With no list, a fooled agent can pay an attacker up to the daily cap,
every day. The change keeps that protection and still allows any payee:

- **Listed payee:** same as today. Signed at once, or held if at or above `queue_at`.
- **Unlisted payee:** always held, at any amount, for a longer window, and it has its own,
  smaller daily cap.
- **Owner's choice:** a vault can keep today's behaviour (refuse unlisted payees).

### Contract changes

**[contracts/policy/src/lib.rs](../contracts/policy/src/lib.rs)**

```rust
pub enum UnlistedPayees {
    Refuse,   // today's behaviour
    Hold,     // new default
}

pub struct AssetCap {
    pub asset: AssetId,
    pub per_tx: U128,
    pub per_24h: U128,
    pub queue_at: U128,
    pub unlisted_per_24h: U128,      // new; 0 means unlisted payees can't be paid in this asset
}

pub struct Policy {
    // ...existing fields...
    pub unlisted: UnlistedPayees,          // new
    pub unlisted_veto_delay_ns: u64,       // new; must be >= veto_delay_ns
}

pub struct Payment {
    pub asset: AssetId,
    pub to: Vec<u8>,
    pub amount: U128,
    pub listed: bool,                     // new; set by the adapter, never by the caller
}
```

- `Policy::validate` adds two checks: `unlisted_veto_delay_ns >= veto_delay_ns`, and
  `unlisted_per_24h <= per_24h`.
- `check()` takes a second ledger reader, `unlisted_spent_24h`. For every charge that includes
  an unlisted payment it:
  - checks `unlisted_per_24h`;
  - forces `Decision::Queue`;
  - returns the delay to use.
- `charges()` keeps adding up all outputs for each asset, so splitting one payment into many
  outputs still counts in full. It also returns the unlisted part of each charge.
- `recheck_parsed()`: with `Refuse`, an unlisted payment fails with `OutputNotWhitelisted`, as
  today. With `Hold`, it passes the list check, but `execute` uses the unlisted delay.

**[contracts/adapters/bitcoin/src/lib.rs:283](../contracts/adapters/bitcoin/src/lib.rs#L283) and
[contracts/adapters/evm/src/lib.rs:166](../contracts/adapters/evm/src/lib.rs#L166)**

- Replace `return Err(OutputNotWhitelisted)` with: if `policy.unlisted == Refuse`, return the
  error; otherwise set `listed = false`.
- Leave every other rule as it is. Change must go to the vault, there's no `OP_RETURN`, there's
  a minimum output size and a fee cap, and only exact `transfer` calls are allowed. These checks
  still stop money hidden in fees or calldata.

**[contracts/covenant-vault/src/lib.rs](../contracts/covenant-vault/src/lib.rs)**

- A second ledger, `unlisted_ledger: LookupMap<AssetId, Vec<(u64, u128)>>` with prefix `b"u"`.
  It gets the same `reserve` and `release` treatment as `ledger`.
- `Pending` gets `delay_ns: u64`. `enqueue` uses
  `executable_at = at + max(veto_delay_ns, unlisted_veto_delay_ns if any unlisted)`.
- `execute` re-reads the delay from today's policy, as it already does for `veto_delay_ns`
  ([lib.rs:327](../contracts/covenant-vault/src/lib.rs#L327)), so raising the delay also applies
  to spends already held.
- `SpendEvent` already carries `payments`, so the dashboard can show "new payee" from `listed`.
- **Migration:** the layout of `Policy` and the vault's stored state changes. Add
  `#[private] #[init(ignore_state)] fn migrate() -> Self`, which reads the old state and fills
  in `unlisted = Refuse`, `unlisted_per_24h = 0` and `unlisted_veto_delay_ns = veto_delay_ns`.
  The live vault keeps working exactly as before until the owner opts in.

### New errors

- `UnlistedCapExceeded`: the unlisted daily cap is spent.
- `UnlistedNotAllowed`: `unlisted_per_24h` is 0 for that asset. Use this instead of
  `OutputNotWhitelisted` when the mode is `Hold`, so the logs show which rule fired.

### Recommended defaults

| | Testnet demo | Real use |
| --- | --- | --- |
| `veto_delay_ns` | 120 s | 24 h |
| `unlisted_veto_delay_ns` | 10 min | 48 h |
| `unlisted_per_24h` | 20% of `per_24h` | owner's choice |

### Dashboard, SDK, MCP, demo

- **Dashboard** ([web/src/CreateVault.tsx](../web/src/CreateVault.tsx),
  [web/src/create.ts](../web/src/create.ts)):
  - a choice between "Only my list" and "Anyone, but hold new payees for veto";
  - a "New payees, most per 24 hours" field for each asset, and the longer window;
  - payees become optional;
  - held unlisted payments show a "NEW PAYEE" badge and a countdown.
- **SDK** [sdk/src/payments.ts](../sdk/src/payments.ts): `resolvePayee` already passes an
  unknown address through. `PayRequest` gets nothing new.
- **MCP** [mcp/src/server.ts](../mcp/src/server.ts): the `pay` description says payments to
  unlisted addresses are held, and that a held payment isn't a failure.
- **Demo:**
  - Change [agent/src/checks.ts](../agent/src/checks.ts) so that "attack passes" means no
    attacker address was signed. Rejected or queued (then vetoed) both count.
  - Add a fourth scenario, `attack-hold`: the poisoned invoice asks for an amount under the cap,
    the payment is held because the payee is new, and the owner vetoes it.
  - Re-record the replay files.
- **Docs:** 24 files mention `OutputNotWhitelisted` (run
  `grep -rl OutputNotWhitelisted . --exclude-dir=node_modules --exclude-dir=target`). Update
  SPEC, SECURITY, HOW_COVENANT_WORKS and the dashboard story text. The old evidence stays valid:
  it was produced in `Refuse` mode.

### Tests

- Unit tests in the policy crate:
  - `unlisted_payee_is_always_queued`
  - `unlisted_cap_counts_split_outputs`
  - `unlisted_delay_applies_on_execute`
  - `refuse_mode_still_refuses`
  - `validate_rejects_unlisted_delay_below_listed`
- Sandbox tests in [tests/integration](../tests/integration):
  - `hold_mode_queues_attacker_and_veto_returns_budget`
  - `raising_unlisted_delay_holds_existing_spend`
  - `migrate_keeps_refuse_mode`
- Attack suites: run every case in `tests/attacks/*.rs` in both modes. None may sign to an
  unlisted address without a held, unvetoed spend.

### Exit check

On the testnet vault in `Hold` mode, a payment to an unknown address is held and the owner vetoes
it. Every test is green, and SECURITY.md has a row for each new claim.

---

## Phase 2: pay anyone on any chain, in any token, through Tidepool

**Status: built on 10 Nov, not yet deployed.** It differs from the design below in five ways:

- **`TxMeta` is unchanged.** The quote is a new optional `quote` argument to `propose_spend`, so
  the agent's function-call key (`propose_spend`, `execute`) needs no change, and callers without
  a quote work as before.
- **Fields are checked against an allowlist.** Unknown quote-request fields are refused, rather
  than ignored, so a later field such as app fees can't skim the swap.
- **The swap's state shares phase 1's migration.** It rides in the same `migrate_v3`, because
  phase 1 isn't deployed yet.
- **Origins are BTC, Base ETH and native SOL.** A Solana token deposit can't be checked against
  the deposit wallet, because the contract can't derive associated token accounts.
- **The dashboard form has an opt-in "Also pay on other chains" box.** It fills in Tidepool's maker
  key, the three origins and every bridged destination, with a one-hour deposit window.

### What Tidepool is (checked on 10 Nov)

[Tidepool](https://www.usetidepool.tech/docs) is a free testnet copy of NEAR Intents' 1Click API,
with the same endpoints and field names. It's community-run and not part of NEAR. The flow:

1. Ask for a quote.
2. Get a one-time deposit address on the chain you pay from.
3. Send exactly `amountIn` to it.
4. Tidepool swaps and delivers to `recipient` on the destination chain, or refunds to `refundTo`.

| Fact | Value |
| --- | --- |
| Base URL | `https://www.usetidepool.tech` |
| Endpoints used | `GET /v0/tokens`, `POST /v0/quote`, `POST /v0/deposit/submit`, `GET /v0/status` |
| Auth | None; any `X-API-Key` value gets the lower fee (20 bps, or 1 bp between stablecoins) |
| Destinations | NEAR tokens, Base, Arbitrum and Ethereum Sepolia (USDC, USDT, ETH), BSC testnet, Solana devnet (SOL, USDC, USDT), Stellar, Sui, Bitcoin testnet4, XRP testnet |
| BTC asset | `nep141:btc.tp-omft.testnet`, from 10,000 to 500,000 sats per leg, one confirmation, `tb1q…` deposit address for each quote |
| Base ETH asset | `nep141:base.tp-omft.testnet`, at most 0.006 ETH per leg |
| Base USDC asset | `nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet`. **This is Tidepool's own test token, not the Circle USDC (`0x036CbD…`) the vault uses today.** |
| Statuses | `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`, `FAILED` |
| Trust | Deposit addresses are custodial: Tidepool derives their keys on its server. There is one market maker, one server, no SLA, and the bridges are run by Tidepool itself. |

### The signed quote (verified on 10 Nov)

The quote's `signature` is `ed25519:<base58>` and comes from the maker's key, the one full-access
key on `maker.tidepool-sandbox.testnet`:

```
ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY
```

The signed message is:

```
sha256( JSON.stringify({ correlationId, timestamp, quoteRequest, quote }) )
```

These are the response's own fields, in the response's own order, without `signature`. I checked
this against a dry quote and a live one (BTC to Base USDC). Both verify, and the live one's signed
`quote` includes `depositAddress` and `deadline`. The docs don't state this format, so the
SDK must check it on every quote and fail closed if it stops verifying.

This makes the plan safe: **the contract can check the quote itself**. An agent can't pair a
harmless-looking quote with a deposit address that leads somewhere else, because the address is
inside the signed bytes.

### What the contract can and can't promise

- **Can:**
  - the money leaves only to the deposit address Tidepool signed, for exactly `amountIn`;
  - refunds come back to the vault;
  - the final recipient and token are ones the policy allows, or the payment is held;
  - the caps count what leaves the vault.
- **Can't:** guarantee Tidepool delivers. Tidepool holds the money for the seconds or minutes
  of the swap. That's the same trust 1Click asks for on mainnet. Losses are bounded by your caps
  and by Tidepool's own limits per leg. Say this in SECURITY.md.

### Contract changes

**New crate, `contracts/adapters/tidepool`** (pure Rust, no C):

```rust
pub struct SignedQuote {
    pub body: Vec<u8>,        // the exact JSON bytes that were signed
    pub signature: [u8; 64],
}

pub struct SwapPlan {
    pub deposit_to: Vec<u8>,          // BTC scriptPubKey or 20-byte EVM address
    pub amount_in: u128,
    pub origin: AssetId,              // mapped from originAsset
    pub destination_asset: String,    // e.g. "nep141:sol.tp-omft.testnet"
    pub recipient: String,
    pub min_amount_out: u128,
    pub deadline_ns: u64,
    pub correlation_id: String,
}

pub fn verify(quote: &SignedQuote, policy: &SwapPolicy, vault: &VaultAddrs, now_ns: u64)
    -> Result<SwapPlan, CovenantError>;
```

`verify` runs these rules in order:

1. `env::ed25519_verify(signature, sha256(body), policy.maker_key)`. The bytes are hashed,
   then parsed, so the fields read are the ones that were signed. `serde_json` refuses duplicate
   keys in a struct, so `{"recipient":A,"recipient":B}` fails to parse. Add a test for it.
2. `quoteRequest.dry == false`, `depositType == "ORIGIN_CHAIN"`,
   `refundType == "ORIGIN_CHAIN"` and `recipientType == "DESTINATION_CHAIN"`. Allow only
   `swapType` `EXACT_INPUT` or `EXACT_OUTPUT`. Refuse `FLEX_INPUT` and `ANY_INPUT`.
3. `refundTo` is the vault's own address on the origin chain. For Bitcoin, decode bech32 to a
   script and compare it with the vault's P2WPKH script; the `bech32` crate is pure Rust. For
   EVM, compare 20 bytes with `evm_address`.
4. `originAsset` is in `policy.swap_origins`, which maps it to an `AssetId`. Anything not
   listed fails with `SwapAssetNotAllowed`.
5. `destinationAsset` is in `policy.swap_destinations`; otherwise `SwapAssetNotAllowed`.
   An empty list refuses everything.
6. `quoteRequest.slippageTolerance <= policy.max_slippage_bps`; otherwise `SlippageTooHigh`.
7. `deadline_ns > now + min_deposit_window_ns` (one hour for Bitcoin, five minutes for EVM) and
   `<= now + 24 h`; otherwise `QuoteExpired`.
8. The deposit address decodes to an output script (Bitcoin) or an address (EVM). Its format
   must match the origin chain; otherwise `QuoteMismatch`.

**[contracts/policy/src/lib.rs](../contracts/policy/src/lib.rs)**

```rust
pub enum TxMeta {
    Bitcoin { prev_txs: Vec<Base64VecU8>, quote: Option<SignedQuoteJson> },  // quote is new
    Evm { quote: Option<SignedQuoteJson> },                                  // was a unit variant
    Solana,
}

pub struct SwapPolicy {
    pub maker_key: [u8; 32],                  // the owner can rotate it with set_policy
    pub swap_origins: Vec<(String, AssetId)>,
    pub swap_destinations: Vec<String>,
    pub swap_payees: Vec<SwapPayee>,          // { destination_asset, recipient, label }
    pub max_slippage_bps: u32,
    pub min_deposit_window_ns: u64,
}

pub struct Policy { /* ... */ pub swap: Option<SwapPolicy> }   // None means swaps are refused
```

**Adapters.** When `meta.quote` is `Some`:

- The transaction must have exactly one external output, and it must be the quote's deposit
  address for exactly `amount_in`. Bitcoin change to the vault is still allowed. For EVM, a
  native transfer has `to == deposit` and `value == amount_in`; an ERC-20 transfer has the token
  equal to `origin` and the call
  `transfer(deposit, amount_in)`. Anything else fails with `QuoteMismatch`.
- The `Payment` it records is `{ asset: origin, to: recipient.as_bytes(), amount, listed }`.
  `listed` is true when `(destination_asset, recipient)` is in `swap_payees`, so phase 1's
  holding rules apply to the **final recipient**, not to Tidepool's deposit address.
- Fees and gas caps apply exactly as now.

**Vault**

- `used_quotes: LookupSet<String>` (prefix `b"x"`) holds correlation IDs. A quote used twice
  fails with `QuoteReused`. Add the ID before signing, and remove it in `on_signed` only if
  signing failed.
- `Pending` stores `deadline_ns`. When a swap is held:
  - `enqueue` fails with `QuoteExpiresInQueue` if
    `executable_at + min_deposit_window_ns > deadline_ns`.
  - `execute` re-checks the deadline and fails with `QuoteExpired` if it has passed.
  - Tidepool quotes last at most 24 hours. So on real settings, held swaps to new payees will
    usually expire; the agent proposes again with a new quote after a veto-free window.
    Document this.
- Events add `swap: Option<{ destination_asset, recipient, min_amount_out, correlation_id }>`,
  so the dashboard can show "0.0002 BTC → 14.5 USDC on Base to 0x2527…".

**New errors:** `QuoteSignatureInvalid`, `QuoteMismatch`, `QuoteExpired`, `QuoteExpiresInQueue`,
`QuoteReused`, `SwapAssetNotAllowed`, `SlippageTooHigh`, `SwapsDisabled`.

**Gas:** `ed25519_verify` and `sha256` run on the host. Parsing about 1.5 KB of JSON costs
little next to the 30 Tgas for each `sign`. Add one row to the gas benchmark.

### SDK ([sdk/src](../sdk/src))

New file [sdk/src/tidepool.ts](../sdk/src/tidepool.ts):

- `tokens()`: reads `GET /v0/tokens`, cached for 10 minutes.
- `quote({ from, toAsset, recipient, amount, swapType })`:
  - asks for a dry quote, then a live one, with `refundTo` set to the vault's own address;
  - **verifies the signature locally** with the pinned maker key, using the same message as the
    contract, so a broken quote fails before any NEAR gas is spent.
- `PayRequest` gets optional `toChain` and `toAsset`. When the target matches the held asset
  and chain, the payment goes direct, as today. Otherwise:
  1. Get a quote.
  2. Build the transaction paying `amountIn` to `depositAddress`.
  3. Propose with `meta.quote`.
  4. Broadcast what gets signed.
  5. `POST /v0/deposit/submit`.
  6. Poll `GET /v0/status` every 3 seconds until it ends.
- Each step is saved to the spend store before it runs, like every payment today:
  `quoted → proposing → signed → broadcast → swap_pending → delivered | refunded | failed`.
  The quote is stored too, because Tidepool asks clients to keep it for disputes.
- `refunded` money is back in the vault. The 24-hour reservation stays on the ledger, which errs
  on the safe side. Note this in the docs.

### MCP ([mcp/src/server.ts](../mcp/src/server.ts))

- `pay`: add optional `to_chain` (`bitcoin`, `base`, `arbitrum`, `ethereum`, `bsc`, `solana`,
  `stellar`, `sui`, `xrp`, `near`) and `to_asset` (a symbol). `asset` stays the coin the vault
  spends.
- New `quote_payment`: a dry quote with the expected `amountOut` and fees. It spends nothing.
- New `list_destinations`: the swap targets the policy allows, from `swap_destinations` joined
  with `/v0/tokens`.
- New `get_payment_status`: the Tidepool status for a swap payment.

### Funding the vault for cross-chain payments

- **BTC:** works today. The vault's `tb1q` address can pay Tidepool directly.
- **Base:** cross-chain USDC must start as Tidepool's USDC (`0x38d8…`), not Circle's. Use ETH
  (at most 0.006 per leg), or fill the vault with Tidepool USDC by swapping BTC into it with
  Tidepool. Add an `Erc20 { chain_id: 84532, token: 0x38d8… }` cap.
- **Cheap extra:** the EVM adapter already works on any chain ID in `evm_chain_ids`, and the
  vault's EVM address is the same everywhere. Adding Arbitrum Sepolia (421614) and Ethereum
  Sepolia (11155111) as origins needs only policy entries and an RPC URL in the SDK.

### Tests

- Copy one real signed quote into `tests/vectors/tidepool_quote.json` and pin the maker key.
- Unit tests:
  - `quote_signature_verifies`
  - `one_flipped_byte_fails`
  - `duplicate_key_json_fails`
  - `refund_not_to_vault_fails`
  - `dry_quote_fails`
  - `flex_input_fails`
  - `deadline_too_close_fails`
  - `output_amount_must_equal_amount_in`
  - `second_output_to_stranger_fails`
  - `reused_correlation_id_fails`
  - `unlisted_recipient_is_held`
- Attack suite, `tests/attacks/tidepool.rs`. The agent:
  - swaps the deposit address for its own;
  - keeps the quote but changes `recipient`;
  - sends `refundTo` to itself;
  - replays an old quote;
  - pays `amountIn + 1`;
  - uses a dry quote.

  Every one must be refused.
- Live: one BTC → Solana devnet SOL payment and one Base ETH → Base Tidepool USDC payment,
  listed in EVIDENCE.md with NEAR, Bitcoin or Base, and Tidepool `status` links.

### Exit check

The MCP `pay` tool, asked to "pay 5 USDC on Solana to <address>" from a BTC-funded vault, ends in
`SUCCESS`. All six attacks above are refused on the sandbox.

---

## Phase 3: create the agent's account from the dashboard

### Flow

1. The form field changes from "Your agent's NEAR account" to **"Agent name"**. Typing `bot`
   while signed in as `alice.testnet` shows `bot.alice.testnet`.
2. The dashboard checks both names are free with `view_account` on `bot.alice.testnet` and on
   `<vault>.<factory>`. Stop before any signing if either exists.
3. The browser creates an ed25519 key pair (`@noble/curves/ed25519`, already a dependency of the
   SDK). The secret stays in memory only: no localStorage, no network.
4. **Transaction 1**, signed by `alice.testnet`, with receiver `bot.alice.testnet`:
   - `CreateAccount`
   - `Transfer` 0.5 NEAR (for storage, and the gas the agent will burn)
   - `AddKey(agentPublicKey, FunctionCall { allowance: 1 NEAR, receiver_id: "<vault>.<factory>",
     method_names: ["propose_spend", "execute"] })`

   A key can name a receiver that doesn't exist yet, so it can be scoped to the vault before
   the vault is created.
5. **Transaction 2**: `create_vault` on the factory, with `agent: bot.alice.testnet`, as today.
6. Send both with NEAR Connect's `signAndSendTransactions`, so there's one wallet prompt.

### Contract change: `set_agent`

The new agent account has **no full-access key**. That's the point: nobody, not even Alice, can
do more with it than ask for payments. It also means its key can't be deleted. Add to the vault:

```rust
pub fn set_agent(&mut self, agent: AccountId) {
    self.assert_owner();
    if agent == self.owner || Some(&agent) == self.guardian.as_ref() { fail(...) }
    self.agent = agent.clone();
    CovenantEvent::AgentUpdated { agent }.emit();
}
```

To revoke a leaked key, the owner points the vault at a new agent account. Add a dashboard
button, **"Replace agent"**, that runs phase 3 again with `set_agent` in place of
`create_vault`.

### Things to check

- **Wallet support:**
  - Test CreateAccount and AddKey in one transaction on each wallet NEAR Connect lists (Meteor,
    MyNearWallet, HOT, Intear).
  - Wallets that refuse get a fallback: create the account in transaction 1, then add the key in
    a second transaction.
  - If a wallet refuses the add-key step too, use an **implicit account** (its name is the hex
    of the public key), which only needs a `Transfer` to exist. Its key never leaves the browser.
- **Leftover NEAR:** about 0.5 NEAR stays stuck in each agent account forever. Say so next to the
  button.
- **A half-finished creation:** if transaction 1 succeeds and transaction 2 fails, show "retry
  creating the vault with the same name". The agent account and key are still valid for that
  vault name.

### Tests

[web/src/create.test.ts](../web/src/create.test.ts):

- builds the right actions;
- refuses an agent name equal to the owner's;
- refuses a taken name;
- the secret never touches `localStorage` (spy on it).

Sandbox: `set_agent_by_non_owner_fails` and `old_agent_rejected_after_set_agent`.

### Exit check

A fresh testnet account creates an agent and a vault from the dashboard with no terminal, and
`view_access_key_list` on the agent shows one function-call key scoped to the vault.

---

## Phase 4: "Create agent key" button

Phase 3 covers new vaults. This button covers an **existing** agent account, for example one
the user created themselves, or the original `covenant` agent.

1. On the vault page, the owner clicks **Create agent key**. The dashboard asks the user to sign
   in **as the agent account**, because only the agent account can add keys to itself.
2. The browser creates the key pair and sends
   `AddKey(pub, FunctionCall { allowance: 1 NEAR, receiver_id: vault, method_names: ["propose_spend", "execute"] })`,
   with receiver = the agent account.
3. Show the secret once (phase 6).
4. **Remove agent key**: a `DeleteKey` button for keys the account can still manage, listed from
   `view_access_key_list` and filtered to keys scoped to this vault.

The page explains in one line that this works only while the agent account still has a key the
wallet controls. Agents made in phase 3 don't, so they use "Replace agent".

This button replaces `make agent-key` for everyone without a terminal.
[scripts/src/create-agent-key.ts](../scripts/src/create-agent-key.ts) stays for terminal use.

### Exit check

On a test agent account, clicking the button adds a key, and that key can `propose_spend` and
can't call `set_policy`. The existing
[access_control.rs:117](../tests/integration/tests/access_control.rs#L117) covers the limits.

---

## Phase 5: publish the MCP server to npm

1. **Name:** `@covenant/mcp` and `@covenant/sdk` don't exist on npm (checked on 10 Nov), but the
   `@covenant` scope may still be owned by someone. Run `npm org ls covenant`, or try to create
   the org. Fall back to `@len3hq/covenant-mcp` and `@len3hq/covenant-sdk`.
2. **SDK:** publish it too, because `mcp` depends on it through `workspace:*`. `pnpm publish`
   rewrites that dependency to the real version. The other option is bundling the SDK into
   `mcp/dist` with `tsup`, which gives one package and fewer moving parts. Recommend bundling.
3. **`mcp/package.json`:**
   - `"bin": { "covenant-mcp": "dist/index.js" }` already exists, and
     [mcp/src/index.ts](../mcp/src/index.ts) has the shebang.
   - Add `"engines": { "node": ">=22" }`, `"publishConfig": { "access": "public" }`,
     `repository`, `license` and `keywords`.
4. **Defaults that must change for `npx`:**
   - Default `SPENDS_FILE` becomes `~/.covenant/<vault>-spends.json`, created with mode
     `0600`. Today it's relative to the current folder, which changes on every `npx` run and
     would lose the record that stops double payments.
   - Default to testnet, and refuse to start if `VAULT_ACCOUNT_ID` doesn't end in `.testnet`,
     until mainnet is supported.
   - `--version` and `--help` flags.
5. **CI:** add a `release.yml` job on tags, running
   `pnpm --filter @covenant/mcp build && npm publish --provenance`.
6. **Smoke test:** `npx -y @covenant/mcp --version`, then call `list_payees` through
   `@modelcontextprotocol/inspector` against the live vault.

### Exit check

On a clean machine with only Node 22, Claude Desktop with the npx config lists the vault's
payees.

---

## Phase 6: ready-made settings snippet

Shown right after phase 3 or 4, in a card with tabs. Every value is filled in, and each tab has a
**Copy** button:

```json
{
  "mcpServers": {
    "covenant": {
      "command": "npx",
      "args": ["-y", "@covenant/mcp"],
      "env": {
        "VAULT_ACCOUNT_ID": "acme.<factory>",
        "AGENT_ACCOUNT_ID": "bot.alice.testnet",
        "AGENT_PRIVATE_KEY": "ed25519:…"
      }
    }
  }
}
```

| Tab | What it shows |
| --- | --- |
| Claude Desktop | The JSON above. Where to put it: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`, then restart Claude |
| Claude Code | `claude mcp add covenant -e VAULT_ACCOUNT_ID=… -e AGENT_ACCOUNT_ID=… -e AGENT_PRIVATE_KEY=… -- npx -y @covenant/mcp` |
| Cursor | The same JSON, for `~/.cursor/mcp.json` |
| Your own code | An `.env` block and the 3-line `Covenant.connect` example |

Rules:

- The secret appears once. Closing the card loses it, and the card says so before it closes.
  There's also a **Download .env** button.
- A warning: the key is saved as plain text in that file. That's acceptable only because it can
  do nothing but ask the vault, which applies your rules. Don't reuse it anywhere else.
- **"Test it"** line: ask your assistant "what are my vault's addresses?", which calls
  `get_addresses`.
- Until phase 5 ships, the snippet uses `node /path/to/covenant/mcp/dist/index.js`. Put this
  behind a flag in [web/src/Docs.tsx](../web/src/Docs.tsx) so the docs match.

### Exit check

Copy, paste and restart Claude Desktop, then "pay Acme Hosting 20,000 sats for INV-1" ends in
`broadcast`.

---

## Phase 7: TEE attestation

A TEE (trusted execution environment) is a sealed part of a processor, such as Intel TDX. It runs
a program that even the machine's owner can't read or change. It can produce an **attestation**:
a report, signed by the chip maker's keys, that says "this exact program, with this hash, is
running sealed, and it made this public key".

Covenant's vault already answers "**is this payment allowed?**" Attestation answers a different
question: "**which program is asking?**" It doesn't stop prompt injection, because a sealed agent
can still be fooled, and the vault's checks still handle that. Its value is in these three
concrete uses.

### 7A. Only the approved agent build can spend (the main idea)

Today, anyone holding `AGENT_PRIVATE_KEY` can propose spends. That key sits in a `.env` file or a
Claude Desktop config on a laptop. A stolen key, or an edited agent (another prompt, another
model, removed safety checks), looks the same to the vault.

**Design**, following NEAR's Shade Agent pattern:

1. The agent (LLM loop, SDK and MCP server) is packaged as a Docker image and run on Phala Cloud
   (dstack, Intel TDX), or another TDX host.
2. At start-up, **inside the sealed environment**, it creates its NEAR key and uses the
   *implicit account* that key defines. It gets a TDX quote whose `report_data` is
   `sha256(agent_account_id)`. The private key never exists outside the sealed environment.
3. A new contract, `covenant-attest`, holds the attestation checks so the vault stays small.
   - `register(quote, collateral)` verifies the TDX quote on-chain with the pure-Rust `dcap-qvl`
     crate, the same approach NEAR's Shade Agent contract uses.
   - It reads the measured image hash (RTMR3 or compose hash) and the `report_data`.
   - It then calls `vault.add_attested_agent(account, image_hash, expires_at)`.
4. The vault changes:
   - `agent: AccountId` becomes `agents: IterableMap<AccountId, AttestedAgent>`, plus the
     existing manual agent while `require_attestation == false`.
   - Policy gets `approved_images: Vec<[u8; 32]>` (owner-set) and `require_attestation: bool`.
   - `assert_agent` accepts a caller only if it's registered, its image is still approved, and
     its attestation hasn't expired (for example after 7 days).
   - `SpendEvent` records `image_hash`, so every payment on the dashboard says which build asked.
5. **Upgrading the agent:** the owner approves the new image hash with `set_policy`, the new
   build registers itself, and the owner removes the old hash. Every agent on the old build
   stops at once.

**What this gives you:**

- **A stolen key can't be used on another machine.** There is no `.env` key to steal.
- **Every payment traces to reviewed code.** Changing one line of the prompt or the tools
  changes the hash, and the vault refuses it.
- **Owners can safely run agents on someone else's server.** The host can't read the key or
  change the program.
- **It covers the track's third NEAR feature.** Covenant uses function-call keys, and the AI
  Security & Defense track also lists "TEE Attestation".

**Cost:** verifying TDX quotes on-chain is heavy work (Intel certificate chains and collateral).
That's why it goes in its own contract. Plan 2 to 3 days. **After the hackathon**, unless 7B is
done and time is left.

### 7B. Proof of which model decided (small, can fit before the deadline)

NEAR AI Cloud runs models inside GPU TEEs and returns an attestation for each response. The agent
already supports any OpenAI-style API through `LLM_BASE_URL` (D7).

1. Point the agent at NEAR AI Cloud.
2. For each model reply that leads to a `pay` call, the SDK keeps the response's attestation and
   puts `sha256(attestation)` in a new optional `memo` field of `propose_spend`. That field is
   stored, never trusted, and limited to 64 bytes.
3. The vault puts the memo in the `SpendProposed` event.
4. The dashboard adds a "Decision proof" link that checks the attestation off-chain. It shows
   the model name, that it ran sealed, and the hash of the exact prompt.

This doesn't secure anything by itself; the vault's rules do that. It turns "the agent paid X"
into a public, checkable record of **which model, with which input, decided to pay**. That's
useful in a dispute, an audit, or an attack review ("the model read this invoice and asked for
this; the vault refused"). Plan half a day.

### 7C. A sealed watcher for Tidepool swaps (later)

Phase 2 can't prove a swap was delivered. Only Tidepool's `/v0/status` says so.

A small sealed service would:

1. Watch each swap's status.
2. Check the destination chain itself (the RPC call for that chain).
3. Report delivered or refunded amounts back to the vault, signed with its attested key.

The vault could then:

- free the budget reserved for refunded swaps;
- mark swaps as *delivered* on-chain;
- freeze itself on its own if a swap goes missing past its deadline.

This needs 7A's registration contract, so it comes after 7A.

### Recommendation

Do **7B** before submission if phases 1 to 6 are done by 12 Nov. Describe **7A** in SECURITY.md
and in the video as the next step, and ship it after the hackathon. Do **7C** after 7A.

---

## SECURITY.md rows to add

| Claim | Test |
| --- | --- |
| An unlisted payee is never signed without a held, unvetoed spend | `hold_mode_queues_attacker_and_veto_returns_budget` |
| Unlisted spending can't exceed its own daily cap, even when split | `unlisted_cap_counts_split_outputs` |
| A swap pays only the deposit address Tidepool signed, for exactly `amountIn` | `output_amount_must_equal_amount_in`, `swaps_deposit_address_refused` |
| Swap refunds can only return to the vault | `refund_not_to_vault_fails` |
| A quote can't be used twice | `reused_correlation_id_fails` |
| The final recipient of a swap obeys the payee rules | `unlisted_recipient_is_held` |
| A replaced agent can no longer propose | `old_agent_rejected_after_set_agent` |
| The dashboard never stores the agent secret | `secret_not_persisted` |

Add to "What Covenant trusts": **Tidepool**, for swap delivery only. It's bounded by the vault's
caps and by Tidepool's own limits per leg.

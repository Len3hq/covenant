> **Snapshot of the original build spec, taken 2 Nov 2026.** Corrections found during setup are listed in
> [BUILD_PLAN.md](BUILD_PLAN.md#spec-corrections), and they win where the two disagree.

# Covenant — Build Phase (1–14 Nov 2026)

2026-10-29 · Obi chinedu frank

## The prompt behind this plan

Everything below this section was generated from this prompt, so you can rerun it later (for example, once team names and skills are known) and diff the result.

```markdown
You are the tech lead for "Covenant", a NEAR Hackathon entry (build window 1 Nov 00:00 – 14 Nov 23:59 UTC 2026; judging 16–18 Nov; human judges plus Claude Code and Codex reading the public repo).

PRODUCT
Covenant is a policy-enforced vault for AI agents across chains. One NEAR smart contract (Rust) controls vault addresses on Bitcoin, EVM chains and (stretch) Solana via NEAR Chain Signatures. The agent holds only a function-call access key that can call propose_spend. For every spend, the contract receives the UNSIGNED transaction, parses it with a per-chain adapter, checks one policy (per-asset per-tx and rolling-24h caps, payee allow-lists, token allow-list, fee/gas caps, EVM chainId, Bitcoin change-to-self), queues large spends for an owner/Sputnik DAO veto, supports a global freeze, computes the signing hash itself (BIP143 for Bitcoin P2WPKH, keccak256 of EIP-1559 RLP for EVM), and only then calls sign on the MPC contract (testnet v1.signer-prod.testnet). It never signs a caller-supplied hash.

SCOPE
Must ship: Bitcoin testnet4 + Base Sepolia (ETH and USDC), agent service, dashboard, attack test suites, recorded testnet evidence, README for human and AI judges, ≤2 min video, X post. Stretch, in order: Solana devnet adapter, Heirloom inheritance mode, TEE second-opinion reviewer. Out of scope: NEAR Intents in the core path (mainnet-only), Taproot (MPC signs ECDSA/Ed25519 only), tokens, landing pages.

TEAM
A team of 3–4. The tech lead (Bitcoin protocol + Rust) owns the contract and Bitcoin adapter. Others: EVM adapter + agent service (TypeScript), dashboard + tests + evidence, optional 4th on Solana + docs/video. Use role labels if names are unknown.

GATES
Gate 1 (4 Nov): contract-signed tx confirms on Bitcoin testnet4. Gate 2 (7 Nov): contract-signed USDC transfer confirms on Base Sepolia. Gate 3 (11 Nov): full recorded run. Feature freeze end of 12 Nov. Submit by 20:00 UTC 14 Nov (submissions can't be edited).

PRODUCE an exact, comprehensive build phase with these sections:
1. Scope and definition of done (measurable).
2. Roles and ownership (folders, decisions, reviewers).
3. Repo layout, conventions, branching, CI, secrets policy.
4. Contract spec: state structs, every public method with signature, access control and behaviour, error enum, events, storage and gas notes.
5. Bitcoin adapter spec: accepted tx shape, parsing, fee and vsize, BIP143 steps, per-input signing, witness assembly, edge cases.
6. EVM adapter spec: accepted tx shapes, RLP fields, calldata rules, chainId, gas cap, signing hash, signature/v handling, edge cases.
7. Solana adapter spec (stretch): accepted instructions, blockhash/durable nonce, Ed25519.
8. Agent service spec: tools, flows, chain routing, data sources, failure handling, the two demo scenarios.
9. Dashboard spec: screens, data, actions.
10. Test plan: unit, integration (near-workspaces + live testnet), named attack tests per chain, property tests, CI gates.
11. Schedule: a timeline of gates, then day-by-day tasks per role with a done-check for each day.
12. Risk register: risk, early signal, fallback, owner.
13. Submission checklist.

RULES: be specific (names, types, commands, numbers); mark anything unverified as "verify"; prefer the smallest design that proves the security claims; every security claim must map to a named test.
```

## Scope and definition of done

Covenant is done when a fresh clone runs `make demo` and a judge watches the contract approve two real payments and refuse two real attacks, on two chains, in under five minutes.

**Must ship (all required for submission)**

- [ ] `covenant-vault` contract deployed on NEAR testnet, controlling a Bitcoin testnet4 P2WPKH address and a Base Sepolia EVM address
- [ ] Bitcoin and EVM adapters, each with its own test suite
- [ ] Policy: per-asset per-tx cap, rolling-24h cap, payee allow-list per chain, token allow-list, fee/gas cap, `chainId` binding, change-to-self, veto queue, global freeze
- [ ] Agent holds only a function-call key for `propose_spend`; a test proves it can't call anything else
- [ ] Agent service: one real LLM call driving `pay`; two scripted scenarios (honest payment, prompt-injected attack)
- [ ] Dashboard: balances, policy, spend log, queue with veto, freeze
- [ ] `EVIDENCE.md` with explorer links for: one BTC payment, one USDC payment, one rejected BTC attack, one rejected EVM `approve`, one vetoed spend
- [ ] README, `NEAR_FEATURES.md`, `AGENTS.md`; video ≤ 2:00; X post saying "built at NEAR HACKATHON"

**Measurable done-checks**

| Check | Target |
| --- | --- |
| `cargo test` in `contracts/` | Green; every invariant in section 10 has ≥ 1 named test |
| `pnpm test` in `agent/` and `web/` | Green |
| `make demo` on a fresh clone | Finishes in < 5 min with only `.env` filled in |
| Contract gas per `propose_spend` (1 BTC input or 1 EVM tx) | Measured and written in README (verify the limit on day 3) |
| Secrets in git history | Zero (gitleaks in CI) |

**Stretch, in this order, only after feature freeze is safe:** Solana devnet adapter → Heirloom inheritance mode → TEE second-opinion reviewer on NEAR AI Cloud.

**Out of scope:** NEAR Intents in the core path (mainnet-only); Taproot (the MPC signs ECDSA and Ed25519 only; verify); any token; a marketing site; mainnet deployment.

## Roles and ownership

Each folder has one owner who merges into it, and the lead reviews every change to `contracts/`. Replace the role labels with names once the team is confirmed.

| Role | Owns (folders) | Decides | Reviews |
| --- | --- | --- | --- |
| **Lead (Frankie):** contract + Bitcoin | `contracts/covenant-vault`, `contracts/adapters/bitcoin`, `contracts/policy` | Contract API, error names, policy schema, scope cuts | Every PR touching `contracts/` |
| **Eng B:** EVM + agent | `contracts/adapters/evm`, `agent/` | Agent tools and prompts, EVM tx shapes | `web/` API calls |
| **Eng C:** dashboard + tests + evidence | `web/`, `tests/attacks/`, `scripts/`, `EVIDENCE.md` | UI, demo scripts | Agent PRs |
| **Eng D (optional):** Solana + docs/video | `contracts/adapters/solana`, `docs/`, video | README wording, video edit | Everything for clarity |

With **three people**, Eng C also takes the README and video. With **two**, Eng B takes the dashboard as a single page, and Solana is dropped.

## Repo layout, conventions and CI

One public monorepo, created on 1 Nov. The Rust workspace and the pnpm workspace sit side by side, with one `Makefile` as the entry point judges use.

```text
covenant/
├─ AGENTS.md              # how to build/test/run; read first by AI judges
├─ README.md  NEAR_FEATURES.md  EVIDENCE.md  SECURITY.md
├─ Makefile               # setup, test, deploy, demo-pay, demo-attack, demo-queue, veto, freeze
├─ .env.example           # account ids + RPC urls; never real keys
├─ Cargo.toml             # Rust workspace
├─ contracts/
│  ├─ covenant-vault/      # #[near] contract: state, methods, queue, sign calls
│  ├─ policy/              # no_std-friendly crate: Policy, Payment, checks (pure, unit-testable)
│  └─ adapters/
│     ├─ bitcoin/          # parse, fee, BIP143, witness helpers
│     ├─ evm/              # EIP-1559 RLP, ERC-20 decode, keccak hash
│     └─ solana/           # stretch
├─ tests/
│  ├─ vectors/             # BIP143 + EIP-1559 fixtures (json)
│  ├─ integration/         # near-workspaces sandbox tests
│  └─ attacks/             # named malicious-proposer suites
├─ agent/                 # TypeScript: LLM loop, tools, chain clients
├─ web/                   # dashboard (Vite + React)
└─ scripts/               # deploy, fund, derive-addresses, record-evidence
```

**Conventions**

- Branches: `main` is always deployable; short-lived `feat/<area>-<thing>` branches; squash merge; PR title = conventional commit (`feat(evm): reject approve calldata`).
- Every PR: tests for new behaviour, `cargo fmt` + `clippy -D warnings`, `pnpm lint` + `tsc --strict`, one reviewer (the lead for `contracts/`).
- Errors: one `CovenantError` enum, with variant names used verbatim in tests, README and video.
- Units: integers only. Sats (`u64`), wei (`u128`), token base units (`u128`). No floats anywhere.
- Commit the `Cargo.lock` and `pnpm-lock.yaml` lockfiles.

**CI (GitHub Actions, on every PR)**

1. `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test --workspace`
2. `cargo near build` (proves the wasm builds; record its size)
3. `pnpm -r lint && pnpm -r test && pnpm -r build`
4. `gitleaks detect` (fail on any secret)
5. Nightly or manual: `make testnet-smoke`, which proposes one tiny spend on each chain

**Secrets:** keys live in a shared password manager and local `.env` only. The demo key in `.env.example` is a throwaway testnet key with dust, rotated before submission.

## Vault contract spec (`covenant-vault`)

All security lives in this one contract. Adapters turn a raw transaction into `Payment`s plus a signing hash. The pure `policy` crate decides. The contract only orchestrates: it reserves budget, queues or signs, and records.

**Core types (in ****`contracts/policy`****)**

```rust
pub enum ChainKind { Bitcoin, Evm, Solana }

pub enum AssetId {
    Btc,
    EvmNative { chain_id: u64 },
    Erc20 { chain_id: u64, token: [u8; 20] },
    Sol,                       // stretch
    Spl { mint: [u8; 32] },    // stretch
}

pub struct Payment { pub asset: AssetId, pub to: Vec<u8>, pub amount: u128 }
// `to` = scriptPubKey bytes (Bitcoin), 20-byte address (EVM), 32-byte pubkey (Solana)

pub struct ParsedTx {
    pub payments: Vec<Payment>,     // external outputs only (change removed)
    pub fee: u128,                  // sats or max wei
    pub signing_hashes: Vec<[u8; 32]>, // one per BTC input; one for EVM
}

pub struct AssetCap { pub asset: AssetId, pub per_tx: u128, pub per_24h: u128, pub queue_at: u128 }
pub struct Payee   { pub chain: ChainKind, pub to: Vec<u8>, pub label: String }

pub struct Policy {
    pub caps: Vec<AssetCap>,          // an asset with no cap is refused
    pub payees: Vec<Payee>,
    pub btc_max_fee_rate: u64,        // sat/vB
    pub btc_max_inputs: u8,           // set from the day-3 gas benchmark (start at 3)
    pub evm_chain_ids: Vec<u64>,      // e.g. [84532] Base Sepolia
    pub evm_max_gas_cost: u128,       // wei: gas_limit * max_fee_per_gas
    pub veto_delay_ns: u64,           // demo: 120 s; real: 24 h
}
```

**Contract state**

| Field | Type | Purpose |
| --- | --- | --- |
| `owner` | `AccountId` | Sets policy, vetoes, freezes, unfreezes |
| `guardian` | `Option<AccountId>` | Sputnik DAO account: may veto and freeze, never unfreeze or set policy |
| `agent` | `AccountId` | The only caller of `propose_spend` / `execute` |
| `signer` | `AccountId` | `v1.signer-prod.testnet` (config, not hard-coded) |
| `paths` | `{btc, evm, sol}: String` | Derivation paths, e.g. `btc-vault-1` |
| `btc_pubkey` | `[u8; 33]` | Derived compressed key; builds scriptCode and change script |
| `evm_address` | `[u8; 20]` | Derived address (same on every EVM chain) |
| `policy` | `Policy` | As above |
| `frozen` | `bool` | Global stop |
| `ledger` | `LookupMap<AssetId, Vec<(u64, u128)>>` | (timestamp, amount) per signed or reserved spend; pruned past 24 h |
| `queue` | `IterableMap<u64, Pending>` | Queued large spends (max 16) |
| `next_id` | `u64` | Spend ids |

`btc_pubkey` and `evm_address` are derived off-chain from the MPC root key and the paths, then set once by the owner in `new`. **Verify** whether `v1.signer` exposes a `derived_public_key` view the contract could call instead.

**Public methods**

| Method | Caller | Behaviour |
| --- | --- | --- |
| `new(owner, guardian, agent, signer, paths, btc_pubkey, evm_address, policy)` | deployer | `#[init]`; validates policy (every cap > 0, `queue_at ≤ per_tx`) |
| `propose_spend(chain: ChainKind, tx: Base64VecU8, meta: TxMeta) -> SpendOutcome` | `agent` | Not frozen → adapter `parse` → policy `check` (incl. rolling 24 h with reservations) → if any payment ≥ `queue_at`: store `Pending`, reserve, return `Queued { id, executable_at }`; else reserve, fire one `sign` per hash, return the signatures via `on_signed` |
| `execute(id)` | `agent` | Delay passed, not vetoed, not frozen → **re-check policy** (it may have tightened) → sign |
| `veto(id)` | `owner` or `guardian` | Removes from queue, releases reservation, emits `spend_vetoed` |
| `freeze()` / `unfreeze()` | owner or guardian / owner only | Freeze blocks propose, execute and pending callbacks |
| `set_policy(policy)` | `owner` | Replaces policy; emits `policy_updated` with a hash of the new policy |
| `on_signed(id, n)` | self only (`#[private]`) | Reads n promise results; on any failure releases the reservation and returns `SignFailed`; else returns `Signed { id, signatures }` |
| views: `get_policy`, `get_addresses`, `get_queue`, `get_spent_24h(asset)`, `is_frozen` | anyone | For dashboard and agent |

`TxMeta` carries what the raw tx can't prove by itself:

- **Bitcoin:** `{ ``prev_txs: Vec<Base64VecU8> }`, the full previous transaction for each input. The contract checks each one hashes to its outpoint and reads amounts and scripts itself (see the Bitcoin adapter).
- **EVM:** nothing.
- **Solana:** stretch.

**Rejection vs panic.** A policy failure does **not** panic. It logs a `spend_rejected` event with the error and returns `Rejected(err)`, so the dashboard and `EVIDENCE.md` show it. Auth failures (`NotAgent`) and malformed bytes do panic.

**Errors (****`CovenantError`****, names used verbatim everywhere)**

`NotAgent`, `NotOwner`, `NotGuardianOrOwner`, `Frozen`, `MalformedTx`, `UnsupportedScript`, `TooManyInputs`, `PrevTxMismatch`, `InputNotOwned`, `OutputNotWhitelisted`, `ChangeNotToVault`, `FeeTooHigh`, `WrongChainId`, `CalldataNotAllowed`, `TokenNotAllowed`, `ValueWithTokenCall`, `GasCostTooHigh`, `AssetNotCapped`, `PerTxCapExceeded`, `DailyCapExceeded`, `QueueFull`, `UnknownSpend`, `NotYetExecutable`, `SignFailed`, `UnlistedNotAllowed`, `UnlistedCapExceeded`.

**Open payees.** `Policy.unlisted` is `Refuse` (the default, and what a policy without the field gets) or `Hold`. With `Refuse`, an output to anyone off the payee list fails with `OutputNotWhitelisted`, as the adapter rules below say. With `Hold`, the adapters accept it, and the vault then:

- sums what the spend pays unlisted payees per asset (fees excluded) and checks it against that asset's `unlisted_per_24h` on a second rolling ledger: zero gives `UnlistedNotAllowed`, and going over gives `UnlistedCapExceeded`;
- still applies every main cap to the whole spend;
- always queues the spend, at any amount, with `executable_at = queued_at + max(veto_delay_ns, unlisted_veto_delay_ns)`;
- at `execute`, recomputes which payments are unlisted under today's payee list, so a payee removed since gets the longer window and the unlisted cap, and switching back to `Refuse` refuses the spend.

`set_policy` requires `unlisted_per_24h <= per_24h`, and in `Hold` mode `unlisted_veto_delay_ns >= veto_delay_ns`. `get_unlisted_spent_24h(asset)` reads the second ledger. `migrate_v3` moves a vault from before open payees, keeping it in `Refuse`.

**Events (NEP-297 JSON logs, ****`standard: "covenant"`****, ****`version: "1.0.0"`****):** `spend_proposed`, `spend_queued`, `spend_signed`, `spend_rejected`, `spend_vetoed`, `frozen`, `unfrozen`, `policy_updated`. Each carries `id`, `chain`, `payments`, `fee`, and the error if any.

**Signing, gas, storage**

- One cross-contract `sign` call per hash, joined with `Promise::and`, then `.then(on_signed)`. Each call carries a path, `key_type` (`Ecdsa` for BTC and EVM) and the payload. **Verify** the exact argument shape, per-call gas, and the required attached deposit against the current near-examples repo.
- The agent's function-call key can't attach deposit, so the **vault pays the ****`sign`**** deposit** from its own balance. Keep the vault funded, and alert in the dashboard when the balance is low.
- Reserve budget **before** firing `sign` and release it in `on_signed` on failure. Concurrent proposals then can't overshoot the 24 h cap.
- Queue entries hold the raw tx (≤ 2 KB); queue capped at 16; the vault account pays storage.
- 300 Tgas is the per-transaction ceiling. `btc_max_inputs` is set from the day-3 benchmark (target 3 inputs per proposal).

**Access keys at deploy**

- `covenant.<team>.testnet`: the contract. After deploy, remove its full-access key or hand it to the owner multisig; decide by day 6.
- `agent.<team>.testnet`: **only** a function-call key with `receiver_id = covenant.<team>.testnet`, `method_names = ["propose_spend", "execute"]`, and an allowance of 1 NEAR.

## Bitcoin adapter spec (`adapters/bitcoin`)

The adapter accepts one transaction shape: P2WPKH vault inputs, SIGHASH_ALL, any allow-listed outputs, change back to the vault. Anything else is refused. It also verifies each input's previous transaction itself. Trusting caller-supplied amounts opens the 2020 SegWit v0 fee attack, explained below.

**Input to ****`parse`**

- `tx`: unsigned transaction in **non-witness** serialization (version, inputs with empty scriptSig, outputs, locktime). A witness-serialized tx (marker `0x00 0x01`) → `MalformedTx`.
- `meta.prev_txs`: the full raw previous transaction for every input (like PSBT `non_witness_utxo`).

**Parsing rules, in order**

1. Version is 1 or 2; locktime = 0; 1 ≤ inputs ≤ `btc_max_inputs`, else `TooManyInputs`; 1 ≤ outputs ≤ 8; no duplicate outpoints.
2. For each input: find its prev tx in `meta`. Its txid = double-SHA256 of the prev tx bytes, byte-reversed; it must equal the outpoint, else `PrevTxMismatch`. Read output `vout`: its scriptPubKey must be the vault script `0x0014 ‖ HASH160(btc_pubkey)`, else `InputNotOwned`. Take its amount.
3. For each output: if scriptPubKey = vault script, it's change. Otherwise it's a `Payment { asset: Btc, to: scriptPubKey, amount }`, and `to` must byte-match a Bitcoin payee (any script type), else `OutputNotWhitelisted`. OP_RETURN and outputs below 330 sats are refused (`UnsupportedScript`).
4. Fee = Σ input amounts − Σ outputs; must be > 0 (checked u64 maths).
5. Size: weight = 4 × len(non-witness tx) + 2 + 108 × inputs (each witness = count 1 + sig 73 + pubkey 34, worst case). vsize = ⌈weight / 4⌉. Fee rate = fee / vsize ≤ `btc_max_fee_rate`, else `FeeTooHigh`.

**Why step 2 matters.** BIP143 commits each input's signature to *that* input's amount only. An attacker who can lie about amounts can split one transaction across two proposals. Each proposal lies about the other input, and each yields one valid signature. Combined, they make a transaction whose real fee is far above the cap. Hardware wallets were hit by exactly this in 2020. Verifying prev txs closes it, which is why `TxMeta::Bitcoin` carries `prev_txs` rather than amounts.

**BIP143 sighash (per input i, SIGHASH_ALL)**

```text
hashPrevouts = dSHA256( ‖ all outpoints (txid LE ‖ vout u32 LE) )
hashSequence = dSHA256( ‖ all nSequence u32 LE )
hashOutputs  = dSHA256( ‖ all outputs (amount u64 LE ‖ varint len ‖ script) )
scriptCode   = 0x1976a914 ‖ HASH160(btc_pubkey) ‖ 0x88ac
preimage     = nVersion ‖ hashPrevouts ‖ hashSequence ‖ outpoint_i ‖ scriptCode
               ‖ amount_i (u64 LE) ‖ nSequence_i ‖ hashOutputs ‖ nLocktime ‖ 0x01000000
sighash_i    = dSHA256(preimage)
```

`dSHA256` = `env::sha256` twice. HASH160 = RIPEMD160(SHA256). NEAR has a `ripemd160` host function (verify); otherwise precompute HASH160 once at `new` and store it.

**Signing and witness (agent side)**

- The contract fires one `sign` per sighash, with `key_type: Ecdsa` on path `paths.btc`.
- The agent converts each result `(big_r, s, recovery_id)` to DER. r = x-coordinate of `big_r`. **Normalise to low-S** (s > n/2 → n − s), or nodes won't relay it. Append the sighash byte `0x01`.
- Witness per input = `[sig, btc_pubkey]`. Serialize with marker/flag, then broadcast via mempool.space `POST /testnet4/api/tx`.

**Named tests (minimum)**

`btc_accepts_whitelisted_payment_with_change`, `btc_rejects_unlisted_output`, `btc_rejects_change_to_foreign_script`, `btc_rejects_fee_rate_above_cap`, `btc_rejects_prev_tx_mismatch`, `btc_rejects_input_not_owned`, `btc_blocks_split_fee_attack` (two proposals, one tx), `btc_rejects_witness_serialization`, `btc_rejects_too_many_inputs`, `btc_rejects_op_return`, `btc_sighash_matches_bip143_vectors` (official BIP143 P2WPKH example + 4 bitcoinjs-generated).

## EVM adapter spec (`adapters/evm`)

The adapter accepts two transaction shapes and refuses everything else: a plain native transfer, and exactly one ERC-20 `transfer` call. That alone blocks `approve`, `transferFrom`, `permit`, multicalls and EIP-7702 delegation, which is how most agent wallets get drained.

**Accepted encoding:** EIP-1559 only. `0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList])`. Types 0, 1, 3 (blobs) and **4 (EIP-7702 set-code)** → `MalformedTx`.

**Rules, in order**

1. RLP decodes exactly, with no trailing bytes and canonical integers (no leading zeros). `accessList` is empty. `to` is 20 bytes (no contract creation).
2. `chainId` ∈ `policy.evm_chain_ids`, else `WrongChainId`. This matters because the vault's EVM address is the same on every EVM chain.
3. `maxPriorityFeePerGas ≤ maxFeePerGas`; gas cost = `gasLimit × maxFeePerGas` ≤ `evm_max_gas_cost`, else `GasCostTooHigh`.
4. Shape A, native transfer: `data` is empty and `value` > 0 → `Payment { asset: EvmNative{chainId}, to, amount: value }`.
5. Shape B, token transfer: `data.len() == 68`, `data[0..4] == a9059cbb` (`transfer(address,uint256)`), bytes 4..16 are zero, `value == 0` (else `ValueWithTokenCall`). Also `Erc20{chainId, token: to}` must have a cap (else `TokenNotAllowed`). Then → `Payment { asset: Erc20{..}, to: data[16..36], amount: data[36..68] }`.
6. Any other `data` (including `approve` `0x095ea7b3`, `transferFrom` `0x23b872dd`, `permit`) → `CalldataNotAllowed`.
7. Payment `to` must match an EVM payee, else `OutputNotWhitelisted`. The fee for caps = gas cost (charged to `EvmNative`).

**Signing hash:** `keccak256(0x02 ‖ rlp(fields))` via `env::keccak256`; one `sign` call, `key_type: Ecdsa`, path `paths.evm`.

**Signature handling (agent side):** r = x-coordinate of `big_r`; `yParity = recovery_id`. If s > n/2, set s = n − s and flip `yParity` (EIP-2 low-s). Then use `viem`'s `serializeTransaction(tx, { r, s, yParity })` and `sendRawTransaction` to Base Sepolia.

**Edge cases and decisions**

- **Nonce** is supplied by the agent and not checked. Two proposals with the same nonce can both be signed, but only one can land. Caps count both (conservative), and the README says caps count *signatures issued*.
- **A signed tx can be held and broadcast later.** Acceptable: it was in policy when signed. Document it.
- **USDC** has 6 decimals; caps are in base units (1 USDC = 1,000,000). The Base Sepolia USDC address comes from Circle's docs (verify on day 1; if the faucet is dry, deploy a mock ERC-20 and say so).
- **Fee-on-transfer or rebasing tokens:** out of scope; allow-list USDC only.

**Named tests (minimum)**

`evm_accepts_native_transfer_to_payee`, `evm_accepts_usdc_transfer_to_payee`, `evm_rejects_approve`, `evm_rejects_transfer_from`, `evm_rejects_arbitrary_calldata`, `evm_rejects_eip7702_type4`, `evm_rejects_legacy_type0`, `evm_rejects_wrong_chain_id`, `evm_rejects_gas_cost_above_cap`, `evm_rejects_value_with_token_call`, `evm_rejects_unlisted_token`, `evm_rejects_unlisted_payee`, `evm_rejects_dirty_address_padding`, `evm_rejects_non_canonical_rlp`, `evm_hash_matches_viem` (5 vectors).

## Solana adapter spec (stretch, start only after 12 Nov freeze is safe)

> Built on 10 Nov. Corrections C17 to C20 in [BUILD_PLAN.md](BUILD_PLAN.md#spec-corrections) win where they differ.

Solana is worth adding only if a durable-nonce transfer signs and lands on devnet in the first half-day. Otherwise skip it and mention it under "next steps".

- **Accepted message:** legacy format only. Versioned v0 messages with address lookup tables → `MalformedTx`, because the accounts they reference can't be checked. The fee payer (account 0) is the vault's Ed25519 address.
- **Required first instruction:** System `AdvanceNonceAccount` on a nonce account whose authority is the vault. A recent blockhash expires within about a minute or two, which MPC latency can exceed (verify on devnet).
- **Allowed instructions after it:** System `Transfer` (index 2) from the vault to an allow-listed payee; SPL Token `TransferChecked` (index 12) from the vault's associated token account, with the mint allow-listed and the destination ATA allow-listed; ComputeBudget `SetComputeUnitPrice` / `SetComputeUnitLimit`, with priority fee × limit ≤ a cap. Any other program or instruction → `CalldataNotAllowed`.
- **Signing:** Ed25519 signs the serialized message itself (no hash), `key_type: Eddsa`, path `paths.sol`. **Verify** the payload length the MPC accepts for Ed25519. If it's capped at 32 bytes, Solana is not feasible this week.
- **Named tests:** `sol_accepts_system_transfer`, `sol_accepts_usdc_transfer_checked`, `sol_rejects_unknown_program`, `sol_rejects_v0_with_lookup_tables`, `sol_rejects_missing_nonce_advance`, `sol_rejects_priority_fee_above_cap`.

## Agent service spec (`agent/`, TypeScript)

The agent is deliberately powerful and gullible. It can pay any address and make arbitrary EVM calls, so the demo proves the contract stops it, not the prompt. It must also run without an LLM key, so judges can reproduce the demo.

**Stack:** Node 20, TypeScript strict, `near-api-js` (function-call key from `.env`), `bitcoinjs-lib` + `@noble/secp256k1`, `viem` (Base Sepolia), `zod` for tool inputs. LLM provider is configurable: NEAR AI Cloud if its API works by day 8 (verify), otherwise any tool-calling model.

**Tools exposed to the LLM**

| Tool | Input | Does |
| --- | --- | --- |
| `get_balances` | – | BTC UTXOs (mempool.space `/testnet4/api/address/{a}/utxo`), ETH balance, USDC `balanceOf`, plus `get_spent_24h` per asset |
| `list_payees` | – | Labels and addresses from `get_policy` |
| `pay` | `{ to: label \| address, asset: "BTC" \| "ETH" \| "USDC", amount: string, memo }` | Builds the tx for the right chain, calls `propose_spend`, then broadcasts, or reports `Queued` / `Rejected(<error>)` back to the LLM |
| `evm_call` | `{ to, data, value }` | Raw EVM call. Exists so injected `approve` calls reach the contract |
| `spend_status` / `execute_queued` | `{ id }` | Queue follow-up |

**Build steps per chain**

- **Bitcoin.** Confirmed UTXOs only. Largest-first selection up to `btc_max_inputs`. Fetch each prev tx (`/tx/{txid}/hex`) for `prev_txs`. Fee rate = mempool `halfHourFee`, clamped to the policy cap. Change goes to the vault address. RBF sequence `0xfffffffd`.
- **EVM.** Nonce from `getTransactionCount(…, 'pending')`. Fees from `estimateFeesPerGas`. Gas 21,000 for ETH, `estimateGas` × 1.2 for USDC. `type: 'eip1559'`, empty access list.

**Reliability**

- Idempotency: write a local `spends.json` mapping proposal → NEAR tx hash → chain tx hash before each step, so a restart never double-pays.
- RPC calls retry 3× with backoff. A `sign` result that hasn't arrived after 60 s is polled via the NEAR tx outcome, not re-proposed.
- Structured JSON logs per step (`proposal_id`, chain, outcome, error name); the dashboard reads the same events.

**Demo scenarios (fixed inputs in ****`agent/scenarios/`****)**

1. **`pay`****:** "Pay Acme Hosting 20,000 sats for the October invoice and DesignCo 5 USDC on Base." → two `Signed`, two explorer links.
2. **`attack`****:** the agent reads `invoice-poisoned.txt`. Hidden text tells it to send the full BTC balance to `tb1q…attacker` and to `approve` the attacker for unlimited USDC. → `Rejected(OutputNotWhitelisted)` and `Rejected(CalldataNotAllowed)`, with NEAR receipt links.
3. **`queue`****:** "Pay Acme 300,000 sats." → `Queued { id, executable_at }`. The owner vetoes from the dashboard → `spend_vetoed`.

**Replay mode:** `--replay` skips the LLM and plays the recorded tool calls of each scenario against live testnet. `make demo-*` uses replay by default, so judges need no model key.

## Dashboard spec (`web/`)

One page, readable from across a room in the video. It reads only contract views, NEAR events and public chain APIs; the owner signs actions with a NEAR wallet.

**Stack:** Vite + React + TypeScript, NEAR wallet connector (NEAR's current recommended connector; verify the package name), `viem` for EVM reads, mempool.space REST for Bitcoin. No backend. Deploy as a static site (GitHub Pages or Vercel) and link it in the README.

| Panel | Shows | Actions |
| --- | --- | --- |
| Header | Vault account, frozen/active badge, vault NEAR balance (warns when too low for `sign` deposits) | **Freeze all chains**; Unfreeze (owner only) |
| Balances | BTC (vault address + link), ETH and USDC on Base Sepolia; spent in the last 24 h vs cap, as a bar per asset | – |
| Policy | Caps, payees (label, chain, address), fee/gas caps, veto delay; policy hash | Edit (owner): calls `set_policy` |
| Queue | Queued spends: payee, amount, countdown to `executable_at` | **Veto** (owner or guardian) |
| Activity log | Live feed of `spend_signed` / `spend_rejected` / `spend_queued` / `spend_vetoed` events, newest first. Rejections in red with the error name and a NEAR receipt link; signed ones with the chain explorer link | Filter by chain |

**Data refresh:** poll views and the NEAR indexer every 3 s during the demo; no WebSockets needed.

**Done-check:** a person who has never seen the project can tell, from a screenshot of the activity log alone, which payments went through and which attacks were blocked.

## Test plan

Every security claim in the README maps to a named test below. Four layers run from fastest to slowest, and the first three gate every PR.

| Layer | Where | Runs | What it proves |
| --- | --- | --- | --- |
| Unit | `contracts/policy`, `contracts/adapters/*` | Every PR, < 30 s | Parsing, hashes against vectors, each policy rule |
| Property | same crates (`proptest`) | Every PR, about 1 min | No random or mutated tx ever yields a signing hash unless policy passes |
| Integration | `tests/integration` (`near-workspaces` sandbox) | Every PR, a few minutes | Access control, queue, ledger, freeze, reservations, using a **mock signer contract** (the sandbox has no MPC) |
| Live smoke | `make testnet-smoke` | Nightly and before recording | Real `v1.signer-prod.testnet` signatures confirm on testnet4 and Base Sepolia |

**Mock signer.** A tiny contract with the same `sign` interface, which returns a deterministic signature or fails on demand. It lets integration tests cover `SignFailed` reservation release without the MPC.

**Property tests (minimum)**

- `prop_mutated_allowed_tx_never_changes_payments_silently`: flip random bytes of an allowed tx. The result is either rejected, or its parsed payments still pass policy.
- `prop_daily_cap_never_exceeded`: random sequences of proposals, vetoes and sign failures. The sum of signed plus reserved amounts never exceeds `per_24h`.
- `prop_evm_only_two_shapes_sign`: random calldata. Only empty data or exact `transfer` encodings reach signing.

**Integration tests (minimum)**

`agent_key_cannot_call_set_policy`, `non_agent_cannot_propose`, `frozen_blocks_propose_and_execute`, `guardian_can_freeze_not_unfreeze`, `queued_spend_not_executable_before_delay`, `vetoed_spend_cannot_execute`, `execute_rechecks_tightened_policy`, `sign_failure_releases_reservation`, `concurrent_proposals_respect_daily_cap`, `rejection_emits_event_without_state_change`, `queue_full_rejects`.

**Invariant → test map (goes into ****`SECURITY.md`****)**

| Invariant | Tests |
| --- | --- |
| Only allow-listed payees (or Bitcoin change to self) receive funds | `btc_rejects_unlisted_output`, `btc_rejects_change_to_foreign_script`, `evm_rejects_unlisted_payee`, `sol_*` |
| EVM: only native transfer or exact ERC-20 `transfer` | `evm_rejects_approve`, `evm_rejects_arbitrary_calldata`, `evm_rejects_eip7702_type4`, `prop_evm_only_two_shapes_sign` |
| Fees and gas bounded; `chainId` bound | `btc_rejects_fee_rate_above_cap`, `btc_blocks_split_fee_attack`, `evm_rejects_gas_cost_above_cap`, `evm_rejects_wrong_chain_id` |
| Contract signs only hashes it computed | `btc_sighash_matches_bip143_vectors`, `evm_hash_matches_viem`; no public method accepts a hash (code review) |
| Caps hold across proposals | `prop_daily_cap_never_exceeded`, `concurrent_proposals_respect_daily_cap`, `sign_failure_releases_reservation` |
| Large spends wait out the veto window | `queued_spend_not_executable_before_delay`, `vetoed_spend_cannot_execute`, `execute_rechecks_tightened_policy` |
| Agent can't escalate; freeze stops everything | `agent_key_cannot_call_set_policy`, `frozen_blocks_propose_and_execute`, `guardian_can_freeze_not_unfreeze` |

**Target:** ≥ 40 named tests by 11 Nov. Put the real count in the README and the video.

## Schedule

Both signing gates land by 7 Nov, which leaves a full week for the agent, dashboard, tests and evidence before the 12 Nov freeze.



Each day ends with a done-check. A missed gate triggers its fallback in the risk register the same evening, not the next morning.

**Week 1: make signing real**

- [ ] **Sun 1 Nov.** *All:* create the repo, CI, `AGENTS.md`, `Makefile` skeleton; deploy an empty vault; derive and fund both vault addresses. *Lead:* `policy` crate types. *Eng B:* RLP decoder skeleton plus EIP-1559 vectors. *Eng C:* mock signer contract, sandbox harness. **Done:** CI green; both addresses funded on-chain.
- [ ] **Mon 2 Nov.** *Lead:* Bitcoin parse + prev-tx verification + unit tests. *Eng B:* EVM decode, both shapes + rejection tests. *Eng C:* dashboard scaffold reading views. **Done:** parsers pass vector tests.
- [ ] **Tue 3 Nov.** *Lead:* BIP143 sighash; match 5 vectors; gas + wasm-size benchmark → set `btc_max_inputs`. *Eng B:* keccak hash matches `viem`. *Eng C:* integration tests for access control. **Done:** hashes match; gas numbers in README draft.
- [ ] **Wed 4 Nov. Gate 1.** *Lead:* `propose_spend` → `sign` → `on_signed`; TS witness assembly; **testnet4 tx confirms**. *Eng B:* EVM signing path against the mock signer. *Eng C:* balances panel. **Done:** a confirmed BTC txid in `EVIDENCE.md`, or the single-input fallback is applied.
- [ ] **Thu 5 Nov.** *Lead:* policy checks: caps, 24 h ledger with reservations, payees, fee caps. *Eng B:* EVM live signing on testnet. *Eng C:* property tests for caps. **Done:** every policy rule has a named test.
- [ ] **Fri 6 Nov.** *Lead:* queue, veto, execute with re-check, freeze, guardian. *Eng B:* EVM edge cases (type 4, padding, canonical RLP). *Eng C:* queue + activity panels. **Done:** integration suite green.
- [ ] **Sat 7 Nov. Gate 2.** *Eng B:* **USDC transfer confirms on Base Sepolia**. *Lead:* agent function-call key; `agent_key_cannot_call_set_policy`; decide on the contract's full-access key. *Eng C:* freeze + veto actions via wallet. **Done:** a USDC tx in `EVIDENCE.md`, or EVM is kept as tested-but-undeployed.

**Week 2: product, proof, story**

- [ ] **Sun 8 Nov.** *Eng B:* agent tools, LLM loop, chain routing, idempotency. *Lead:* review + fix contract findings. *Eng C:* Bitcoin attack suite. **Done:** `pay` scenario works end to end on both chains.
- [ ] **Mon 9 Nov.** *Eng B:* `attack` and `queue` scenarios, plus `--replay` recording. *Lead:* `SECURITY.md` trust model. *Eng C:* EVM attack suite. **Done:** all 3 scenarios pass in replay mode.
- [ ] **Tue 10 Nov.** *All:* bug bash. *Eng C:* dashboard polish, static deploy. *Lead:* `NEAR_FEATURES.md`. **Done:** dashboard live at a public URL.
- [ ] **Wed 11 Nov. Gate 3.** *All:* full recorded testnet run of all scenarios; explorer links into `EVIDENCE.md`; count tests (target ≥ 40). Multi-input Bitcoin if gate 1 allowed it. **Done:** `EVIDENCE.md` complete.
- [ ] **Thu 12 Nov. Feature freeze (end of day).** Stretch only if gate 3 passed: Solana (Eng D or B) → Heirloom → TEE reviewer. Everyone else: README draft, GIF. **Done:** `main` tagged `rc1`; after this, bug fixes only.
- [ ] **Fri 13 Nov.** README final; record two video takes; edit to ≤ 2:00; fresh-clone test on a clean machine. **Done:** video exported; fresh clone passes.
- [ ] **Sat 14 Nov.** Rotate demo keys; tag `v1.0.0-hackathon`; X post; submit by 20:00 UTC; confirmation screenshot. **Done:** submitted.

**Daily rhythm:** 15-minute standup at a fixed time (yesterday's done-check, today's, blockers); lead triages scope at every standup; one shared board mirrors these checkboxes.

## Risk register

The two risks that could sink the entry are the testnet MPC being slow or down, and the contract-to-signer call shape. Both are tested before 1 Nov and again on day 1.

| Risk | Early signal | Fallback | Owner |
| --- | --- | --- | --- |
| Testnet MPC slow or down | Prep spike latency > 30 s, or failures | Record evidence early (day 11); mock-signer replay mode for local demo; ask DevRel | Lead |
| `sign` call shape or deposit differs from docs | Spike fails on 31 Oct or day 1 | Copy the current near-examples contract call exactly; pin its version | Lead |
| Multi-input Bitcoin exceeds 300 Tgas | Day-3 benchmark | `btc_max_inputs = 1`, plus a consolidation step before the demo | Lead |
| Contract wasm too large | `cargo near build` size in CI | Hand-rolled parsers, no `bitcoin` crate, `opt-level = "z"`, LTO | Lead |
| EVM adapter slips | No Base Sepolia tx by 7 Nov | Ship Bitcoin-only; EVM stays tested and undeployed, shown in tests and video | Eng B |
| Faucets dry (testnet4, Base Sepolia ETH or USDC) | Day 1 funding | Prep funds early; signet as Bitcoin backup; mock ERC-20 for USDC | Eng C |
| LLM API flaky during recording | Retries in logs | `--replay` mode; record the LLM run separately | Eng B |
| Scope creep (Solana, Heirloom) | Anything started before freeze | Hard rule: no stretch work until gate 3 passes | Lead |
| Secrets leak in the public repo | gitleaks CI failure | Rotate keys immediately; testnet keys only | Everyone |
| Submission form issue near deadline | – | Submit by 20:00 UTC on 14 Nov; screenshot the confirmation | Lead |

## Submission checklist (13–14 Nov)

Submissions can't be edited once sent, so finish every box before 20:00 UTC on 14 Nov.

**Repo**

- [ ] Public; default branch `main`; CI green; release tag `v1.0.0-hackathon`
- [ ] README: one-line pitch, GIF, problem, "Try it in 3 minutes" (`make setup`, `make demo-pay`, `make demo-attack`, `make demo-queue`), architecture diagram, invariants
- [ ] `NEAR_FEATURES.md`: feature → file:line → why it's necessary
- [ ] `SECURITY.md`: trust model + invariant → test map
- [ ] `EVIDENCE.md`: contract id, vault addresses, explorer links for every demo outcome, test count
- [ ] `AGENTS.md`: build, test, run, repo map
- [ ] Limitations section: P2WPKH only, no Taproot, caps count signatures issued, UTXO/nonce data from APIs, unaudited
- [ ] gitleaks clean; `.env.example` holds only throwaway testnet values
- [ ] Fresh clone on a clean machine: `make setup && make demo-pay` works

**Video and post**

- [ ] Video ≤ 2:00 following the script in the strategy doc; real test count; captions on
- [ ] X post: "Built at NEAR HACKATHON", the video, repo link, @NEARProtocol

**Form (nearhackathon.com/#apply)**

- [ ] Project name, team lead, email, team size
- [ ] Tracks: AI Security & Defense, Autonomous Business, Real-World Money, Unstoppable DeFi, Open Innovation
- [ ] Mainnet NEAR wallet for the payout; team has agreed the prize split in writing
- [ ] Repo link, X post link, optional website (dashboard URL)
- [ ] Description: the 1,735-character draft, updated to match what shipped
- [ ] Submitted; confirmation screenshot saved

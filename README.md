# Covenant

A policy-enforced vault for AI agents across chains. One NEAR contract controls vault addresses on
Bitcoin, EVM chains and Solana through Chain Signatures, and it signs a spend only after parsing the
transaction itself and checking it against one policy. The agent can ask for anything. The contract
decides what gets signed.

**Demo video:** [on X](https://x.com/frankieetchy/status/2121314676550123822). Live dashboard, on testnet:
https://covenant.len3.xyz

![The Covenant dashboard: the live demo vault's Activity tab, where the contract refused a payment to an address that isn't a payee](docs/screenshots/vault-activity.png)

New to it? [docs/HOW_COVENANT_WORKS.md](docs/HOW_COVENANT_WORKS.md) explains Covenant from zero, with no
crypto background assumed.

## The problem

An AI agent that pays bills needs a key that can move money. If that key sits with the agent, anything
that misleads the agent can spend it: a poisoned invoice, a prompt injection in an email, or a bug.
Rules written in the agent's prompt or code don't help, because the agent is the part that has been
fooled. Covenant puts the rules on chain instead. The agent can only ask the vault to pay. The vault
contract reads the transaction itself, checks it against the owner's rules, and only then asks NEAR's
MPC network to sign it. A misled agent gets a refusal, not a payment.

Covenant runs on NEAR testnet, Bitcoin testnet4, Base Sepolia and Solana devnet. It is unaudited.

## Try it

Each step says what to do and what you should see.

### 1. The keyless demo, on a fresh clone

Needs Rust (via rustup), Node 22, pnpm 11 and gitleaks (for `make check` only). No keys, no `.env` edits.
The first run compiles cargo-near and the contracts, which takes several minutes; after that the
scenarios take about a minute, and seconds on later runs.

```sh
git clone https://github.com/Len3hq/covenant && cd covenant
make setup   # installs cargo-near and the JS dependencies, copies .env.example to .env
make demo    # builds the contracts, starts a local NEAR sandbox and runs three scenarios
```

`make demo` deploys the real vault contract to a local sandbox, with a mock MPC signer and simulated
chains, then replays an agent's recorded tool calls. You should see:

- **pay**: `PASS: 2 of 2 payments signed`. A BTC payment and a USDC payment to known payees.
- **attack**: `PASS: the contract refused both attacks: OutputNotWhitelisted and CalldataNotAllowed`.
  A poisoned invoice tells the agent to send 600,000 sats to a stranger and to approve unlimited USDC
  to another address. The agent tries both, and the contract refuses both.
- **queue**: `PASS: 1 spend queued for the veto window, 0 signed`. A payment above the threshold waits,
  the owner vetoes it, and its budget is returned.
- Last line: `All scenarios passed in … s`.

![Output of make demo: two payments signed, both attacks refused with OutputNotWhitelisted and CalldataNotAllowed, one large payment queued and vetoed](docs/screenshots/make-demo.png)

`make test` runs the Rust, sandbox and TypeScript tests. `make check` runs everything CI runs.

### 2. The live dashboard, no install

1. Open https://covenant.len3.xyz and press **See the live demo vault**. You should see the vault's
   Bitcoin, Base and Solana addresses, its balances, and the **Activity** tab listing every payment the
   contract signed or refused on testnet, with the reason for each refusal.

   ![The live demo vault's Overview tab: payments signed and refused, and balances on Bitcoin, Base and Solana against their 24-hour limits](docs/screenshots/vault-overview.png)
2. Connect a NEAR testnet wallet (such as Meteor or Intear; [get testnet NEAR](https://docs.near.org/getting-started/faucet#external-faucet))
   and press **Create**. A five-step wizard sets the name, the agent, who it may pay and the limits.
   Your wallet signs twice: once to create the vault, once to add the agent's key. You should then see
   your new vault's page with its own addresses; **My vaults** lists it.

   ![Step 1 of the five-step Create a vault wizard: name, agent, payments, limits, review](docs/screenshots/create.png)
3. On its **Rules** tab, change a limit. You should see each change listed before your wallet signs.
   **Freeze** stops all payments at once.

   ![The Rules tab: the payees the vault may pay; anyone else is refused](docs/screenshots/vault-rules.png)

### 3. Your own agent paying from your vault

- **From Claude, ChatGPT, Cursor or VS Code, by URL:** create the vault and pick **Hosted** for
  its agent. The page that follows, and later the vault's **Agent** tab, shows the vault's own MCP
  address and the steps for each app. Adding it sends you back
  to the dashboard to sign a grant (a message, not a transaction). Then ask the app to "list my
  payees" or "pay my first payee 1000 sats". You should see the payment on the vault's **Activity** tab,
  signed, refused or held, with a link to the chain explorer. Details: [docs/HOSTED.md](docs/HOSTED.md).
- **With the MCP server, run yourself:** `npx -y @len3hq/covenant-mcp@latest --help` lists the settings.
  The dashboard's **Agent** tab gives the full config for your vault ([mcp/](mcp/)).
- **From code:** `npm install @len3hq/covenant-sdk`, then `Covenant.connect(...)` and
  `wallet.pay({ asset, to, amount, reference })` ([sdk/](sdk/)).

Payments on testnet need the vault funded: each vault's **Fund** tab has its addresses and faucet links.
Payments that went through on real test networks are listed with explorer links in
[EVIDENCE.md](EVIDENCE.md).

## How a spend works

1. The agent builds an unsigned transaction and calls `propose_spend`, using a function-call key that can't reach any owner method.
2. The contract parses the raw bytes with a per-chain adapter and computes the signing hash itself. It never accepts a hash from the caller. On Solana, Ed25519 signs the checked message itself.
3. The policy checks caps, payees, tokens, fees and chain ID. A Solana message must come from the vault alone and advance a durable nonce, so a payment held for a veto can still land.
4. Rejected spends are logged, large ones wait out a veto window, and the rest go to the MPC signer.

## Your own vault

Connect a NEAR testnet wallet on the [dashboard](https://covenant.len3.xyz) and
press **Create**. A five-step wizard sets the name, the agent, who it may pay, the limits (presets or
your own) and a review. The factory gives you a separate vault with its own Bitcoin, Base and Solana
addresses; you own it, its code can't be changed by anyone, and we hold no keys or funds.

- **My vaults** (`?mine`) lists every vault your wallet created, as cards.
- Each vault's page has **Overview**, **Activity** (the veto queue and every decision), **Rules** (with
  a form to change them, which lists each change before your wallet signs), **Agent** (keys, replace
  agent) and **Fund** (each address with a copy button and its faucets) tabs, and a one-click **Freeze**.
- Payees are paid at once. Anyone else is refused, or, if you allow it, paid only after a wait you can
  veto. Payments on other chains and tokens go through Tidepool's testnet swaps.

Any vault can be viewed at `?vault=<account>`. Testnet only, and unaudited.

## Connect your own agent

- **Hosted, by URL** ([hosted/](hosted/), [docs/HOSTED.md](docs/HOSTED.md)): create a vault with a
  *Hosted* agent and add the connector URL to Claude, ChatGPT, Claude Code, Cursor, VS Code or any app
  that adds a remote MCP server with OAuth. The agent's key is made inside an Intel TDX enclave on
  OutLayer and never leaves it; your wallet signs a grant that lets it act for that one vault, until it
  expires.
- **MCP server, run yourself** ([mcp/](mcp/)): gives Claude Desktop, Claude Code, Cursor, VS Code or any
  MCP client `pay`, `list_payees`, `get_balances` and more, with the agent's restricted key in your own
  config.
- **TypeScript SDK** ([sdk/](sdk/)): `Covenant.connect(...)`, then `wallet.pay({ asset, to, amount, reference })`.
  It builds and proposes the transaction, broadcasts what the vault signs, and never pays the same
  reference twice. A `signer` can hold the key elsewhere, such as an enclave.

Whichever you use, the vault decides every payment. The
[docs](https://covenant.len3.xyz/?docs) cover each step, every AI app, every
error and common problems.

## Running against testnet

`make demo LIVE=1` runs the same scenarios against a testnet vault with the agent's key in `.env`, and
`LLM=1` drives them with a real model instead of the recorded tool calls. A real model may ignore the
poisoned invoice; the attack then passes as long as no attacker is paid, since the recorded calls
already test both refusals. `make help` lists every target, and [AGENTS.md](AGENTS.md) lists the
commands for deploying, paying and administering a vault. Testnet commands need the
[NEAR CLI](https://github.com/near/near-cli-rs).

## Gas

NEAR limits a transaction to 300 Tgas. A proposal must prepay its own execution, 30 Tgas for each
`sign` call and 20 Tgas for the callback, so the number of Bitcoin inputs is what sets the limit.

| Spend | Prev tx size | Proposal receipt (Tgas) | Must prepay (Tgas) | Total burnt (Tgas) |
| --- | --- | --- | --- | --- |
| Bitcoin, 1 input | About 220 bytes | 2.8 | 52.8 | 6.5 |
| Bitcoin, 1 input | About 10,000 bytes | 3.8 | 53.8 | 8.1 |
| Bitcoin, 2 inputs | About 220 bytes | 3.4 | 83.4 | 8.6 |
| Bitcoin, 2 inputs | About 10,000 bytes | 5.4 | 85.4 | 11.8 |
| Bitcoin, 3 inputs | About 220 bytes | 4.0 | 114.0 | 10.6 |
| Bitcoin, 3 inputs | About 10,000 bytes | 6.9 | 116.9 | 15.4 |
| Bitcoin, 5 inputs | About 220 bytes | 5.1 | 175.1 | 14.7 |
| Bitcoin, 5 inputs | About 10,000 bytes | 10.0 | 180.0 | 22.7 |
| Bitcoin, 8 inputs | About 220 bytes | 6.8 | 266.8 | 20.9 |
| Bitcoin, 8 inputs | About 10,000 bytes | 14.7 | 274.7 | 33.7 |
| EVM, USDC transfer | n/a | 2.8 | 52.8 | 6.6 |
| Solana, SOL transfer | n/a | 2.8 | 52.8 | 6.8 |
| Solana, USDC transfer with priority fee | n/a | 3.1 | 53.1 | 7.3 |

`btc_max_inputs` is 3, the spec's target, which needs at most 116.9 Tgas. Measured on 4 Nov in the
sandbox on the 263 KB vault itself (the Solana rows on 10 Nov, on the 305 KB vault), including its policy checks and ledger, against the mock signer.
"Total burnt" therefore excludes the real MPC network's work. To reproduce:
`make wasm && cargo test -p covenant-integration-tests --test gas_bench -- --nocapture`.

## Screenshots

All taken from the live dashboard on 13 Nov 2026, viewing the demo vault `covenant.len3hq.testnet`
without a wallet connected. BTC shows "Unavailable" because the mempool.space testnet4 API was not
answering at the time; the dashboard says so rather than showing a stale number.

| Page | What it shows |
| --- | --- |
| [Landing](docs/screenshots/landing.png) | The pitch and the three ways in: create a vault, connect a wallet, see the demo vault |
| [Overview](docs/screenshots/vault-overview.png) | Counts of signed and refused payments, balances per chain against the 24-hour limits, the latest refusal |
| [Activity](docs/screenshots/vault-activity.png) | The veto queue and the decision log, with each refusal's `CovenantError` and its NEAR transaction |
| [Rules](docs/screenshots/vault-rules.png) | Payees and limits, as read from the contract |
| [Agent](docs/screenshots/vault-agent.png) | The agent's restricted key, and who can do what: agent, Sputnik DAO guardian, owner |
| [Fund](docs/screenshots/vault-fund.png) | The vault's Bitcoin, Base and Solana addresses, all derived through Chain Signatures, and faucets |
| [Create](docs/screenshots/create.png) | The five-step wizard that deploys a new vault from the factory |
| [Docs](docs/screenshots/docs.png) | The in-app docs at `?docs` |
| [make demo](docs/screenshots/make-demo.png) | The keyless demo's output on a local sandbox |

## Other hackathon project

A member of this team also built [Prove-It](https://github.com/christian-obi/proveit) for NEAR
HACKATHON (Nov 2026): verifiable private trading track records, computed in an OutLayer TEE and
recorded on NEAR. The two projects are independent and share no code.

## Repo map

| Path | Contents |
| --- | --- |
| [contracts/covenant-vault](contracts/covenant-vault) | The NEAR contract |
| [contracts/policy](contracts/policy) | Core types and pure policy checks |
| [contracts/adapters](contracts/adapters) | Bitcoin, EVM and Solana parsers and signing payloads |
| [tests](tests) | Vectors, sandbox tests, attack suites |
| [agent](agent) | TypeScript agent service |
| [web](web) | Dashboard |
| [hosted/enclave](hosted/enclave) | The hosted agents' key holder, for OutLayer's TDX enclaves |
| [hosted/connector](hosted/connector) | The hosted connector: MCP over HTTP, with OAuth |
| [scripts](scripts) | Deploy, funding and evidence scripts |
| [docs](docs) | How it works, the hosted connector, the MPC signing spike, screenshots |

See also [AGENTS.md](AGENTS.md), [SECURITY.md](SECURITY.md), [NEAR_FEATURES.md](NEAR_FEATURES.md) and [EVIDENCE.md](EVIDENCE.md).

## Built with

No starter template or boilerplate repository was used: the monorepo was set up by hand in the first
commit. One file is copied: [hosted/enclave/wit/signing-keys.wit](hosted/enclave/wit/signing-keys.wit),
OutLayer's interface for keys held in its enclaves. The code was written with Claude Code, and commits
say so in a `Co-Authored-By` line.

Services used: NEAR Chain Signatures (the MPC signer `v1.signer-prod.testnet`), NEAR global contracts
(for the vault factory), [OutLayer](https://outlayer.ai) Intel TDX enclaves (for hosted agents' keys),
Tidepool's testnet swap quotes, the mempool.space testnet4 API, Base Sepolia and Solana devnet public
RPC, FastNear and drpc NEAR RPC, and Railway (hosting the dashboard and connector).

| Part | Libraries |
| --- | --- |
| Contracts (`contracts/`) | `near-sdk`, `hex`, `ed25519-dalek`; unit tests: `proptest` |
| Sandbox and attack tests (`tests/`) | `near-workspaces`, `tokio`, `anyhow`, `serde_json`, `sha2`, `ripemd`, `ed25519-dalek`, `bs58`, `base64` |
| Enclave key holder (`hosted/enclave`) | `wit-bindgen`, `serde`, `serde_json`, `borsh`, `sha2`, `bs58`, `base64`, `ed25519-dalek`, `wasi-http-client` |
| SDK (`sdk/`) | `near-api-js`, `viem`, `bitcoinjs-lib`, `@noble/curves`, `@noble/hashes`, `@scure/base`, `zod` |
| MCP server (`mcp/`) | `@modelcontextprotocol/sdk`, `zod`, the SDK |
| Hosted connector (`hosted/connector`) | `express`, `@modelcontextprotocol/sdk`, `near-api-js`, `@solana/web3.js`, `@noble/*`, `@scure/base`, `zod` |
| Dashboard (`web/`) | `react`, `react-dom`, `vite`, `@hot-labs/near-connect` (wallets), `@noble/*`, `@scure/base`, Fontsource fonts (Mona Sans, Space Grotesk, JetBrains Mono) |
| Demo agent (`agent/`) | `@anthropic-ai/sdk` for Claude models, or any OpenAI-compatible API, for `LLM=1`; `near-api-js`, `viem`, `bitcoinjs-lib`, `zod` |
| Scripts (`scripts/`) | `@noble/*`, `@scure/base`, `bitcoinjs-lib`, `viem`, `@solana/web3.js` |
| Tooling | `cargo-near`, TypeScript, ESLint, `typescript-eslint`, Vitest, pnpm, gitleaks |

## Hackathon

All code was written during NEAR HACKATHON: the first commit is from 2 November 2026, and there is no
pre-hackathon code, so there is no `pre-hackathon` tag. The tag `hackathon-submission` marks the
submitted commit.

## License

- Everything outside `hosted/`, including the vault contracts, the SDK, the MCP server, the dashboard
  and the agent: [Apache License 2.0](LICENSE).
- The hosted connector and key holder in [hosted/](hosted/): [Business Source License 1.1](hosted/LICENSE).
  You may read, change and run it, for yourself and on any test network; you may not offer it to
  others as a hosted service. Each version becomes Apache 2.0 four years after it's published.

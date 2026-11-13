# Covenant

A policy-enforced vault for AI agents across chains. One NEAR contract controls vault addresses on
Bitcoin, EVM chains and Solana through Chain Signatures, and it signs a spend only after parsing the
transaction itself and checking it against one policy. The agent can ask for anything. The contract
decides what gets signed.

> **Status: in active build.** The vault on NEAR testnet now parses, checks and signs real spends,
> with confirmed payments on Bitcoin testnet4 and Base Sepolia ([EVIDENCE.md](EVIDENCE.md)). Live payments now
> include USDC, sent with the agent's restricted key. Large spends wait in a veto queue, which the
> owner or guardian DAO can clear, and an LLM agent can now drive payments through the contract. Solana
> (SOL and SPL USDC, signed with Ed25519) is live on the testnet vault, which has refused a Solana attack
> and paid on Solana devnet. Progress
> is tracked in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## How a spend works

1. The agent builds an unsigned transaction and calls `propose_spend`, using a function-call key that can't reach any owner method.
2. The contract parses the raw bytes with a per-chain adapter and computes the signing hash itself. It never accepts a hash from the caller. On Solana, Ed25519 signs the checked message itself.
3. The policy checks caps, payees, tokens, fees and chain ID. A Solana message must come from the vault alone and advance a durable nonce, so a payment held for a veto can still land.
4. Rejected spends are logged, large ones wait out a veto window, and the rest go to the MPC signer.

## Live dashboard

https://covenant.len3.xyz: create your own vault, or open the live demo vault to see every payment it signed or refused, and why.

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

## Quick start

Requires Rust (via rustup), Node 22, pnpm 11 and gitleaks. Testnet commands also need the
[NEAR CLI](https://github.com/near/near-cli-rs).

```sh
make setup   # install cargo-near and JS dependencies, create .env
make test    # build the wasm, then run Rust, sandbox and TypeScript tests
make help    # list every target
```

`make demo` runs all three scenarios on a local sandbox with no keys: the real contract, a mock signer
and simulated chains. Add `LIVE=1` to run on testnet with the agent's key, and `LLM=1` to use a real
model instead of the saved tool calls. A real model may ignore the poisoned invoice; the attack then
passes as long as no attacker is paid, since the saved calls already test both refusals.

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
| [docs](docs) | Build plan and spec |

See also [AGENTS.md](AGENTS.md), [SECURITY.md](SECURITY.md), [NEAR_FEATURES.md](NEAR_FEATURES.md) and [EVIDENCE.md](EVIDENCE.md).

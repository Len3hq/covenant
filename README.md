# Covenant

A policy-enforced vault for AI agents across chains. One NEAR contract controls vault addresses on
Bitcoin and EVM chains through Chain Signatures, and it signs a spend only after parsing the
transaction itself and checking it against one policy. The agent can ask for anything. The contract
decides what gets signed.

> **Status: early build.** A skeleton of the vault is on NEAR testnet, and a separate spike has
> proved contract-initiated MPC signing ([docs/SPIKE.md](docs/SPIKE.md)). The adapters parse
> transactions and compute signing hashes, but the vault doesn't call them yet, so `propose_spend`
> still refuses every transaction. Progress is tracked in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## How a spend works

1. The agent builds an unsigned transaction and calls `propose_spend`, using a function-call key that can't reach any owner method.
2. The contract parses the raw bytes with a per-chain adapter and computes the signing hash itself. It never accepts a hash from the caller.
3. The policy checks caps, payees, tokens, fees and chain ID.
4. Rejected spends are logged, large ones wait out a veto window, and the rest go to the MPC signer.

## Quick start

Requires Rust (via rustup), Node 22, pnpm 11 and gitleaks. Testnet commands also need the
[NEAR CLI](https://github.com/near/near-cli-rs).

```sh
make setup   # install cargo-near and JS dependencies, create .env
make test    # build the wasm, then run Rust, sandbox and TypeScript tests
make help    # list every target
```

The `demo-*`, `veto`, `freeze` and `testnet-smoke` targets exit with an error naming the
milestone that delivers them.

## Gas

NEAR limits a transaction to 300 Tgas. A proposal must prepay its own execution, 30 Tgas for each
`sign` call and 20 Tgas for the callback, so the number of Bitcoin inputs is what sets the limit.

| Spend | Prev tx size | Proposal receipt (Tgas) | Must prepay (Tgas) | Total burnt (Tgas) |
| --- | --- | --- | --- | --- |
| Bitcoin, 1 input | 219 bytes | 2.3 | 52.3 | 5.5 |
| Bitcoin, 1 input | 9,999 bytes | 3.3 | 53.3 | 6.5 |
| Bitcoin, 2 inputs | 219 bytes | 2.9 | 82.9 | 7.5 |
| Bitcoin, 2 inputs | 9,999 bytes | 4.9 | 84.9 | 9.5 |
| Bitcoin, 3 inputs | 219 bytes | 3.5 | 113.5 | 9.5 |
| Bitcoin, 3 inputs | 9,999 bytes | 6.4 | 116.4 | 12.5 |
| Bitcoin, 5 inputs | 219 bytes | 4.6 | 174.6 | 13.5 |
| Bitcoin, 5 inputs | 9,999 bytes | 9.5 | 179.5 | 18.6 |
| Bitcoin, 8 inputs | 219 bytes | 6.3 | 266.3 | 19.5 |
| Bitcoin, 8 inputs | 9,999 bytes | 14.1 | 274.1 | 27.6 |
| EVM, USDC transfer | n/a | 2.1 | 52.1 | 5.3 |

`btc_max_inputs` is 3, the spec's target, which needs at most 116.4 Tgas and leaves room for the
policy checks still to come. Measured on 3 Nov in the sandbox with a 181 KB bench contract running
the real adapters against the mock signer, so "total burnt" excludes the real MPC network's work.
The bench has no policy, ledger or queue yet. To reproduce:
`make wasm && cargo test -p covenant-integration-tests --test gas_bench -- --nocapture`.

## Repo map

| Path | Contents |
| --- | --- |
| [contracts/covenant-vault](contracts/covenant-vault) | The NEAR contract |
| [contracts/policy](contracts/policy) | Core types and pure policy checks |
| [contracts/adapters](contracts/adapters) | Bitcoin and EVM parsers and signing hashes |
| [tests](tests) | Vectors, sandbox tests, attack suites |
| [agent](agent) | TypeScript agent service |
| [web](web) | Dashboard |
| [scripts](scripts) | Deploy, funding and evidence scripts |
| [docs](docs) | Build plan and spec |

See also [AGENTS.md](AGENTS.md), [SECURITY.md](SECURITY.md), [NEAR_FEATURES.md](NEAR_FEATURES.md) and [EVIDENCE.md](EVIDENCE.md).

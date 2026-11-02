# Covenant

A policy-enforced vault for AI agents across chains. One NEAR contract controls vault addresses on
Bitcoin and EVM chains through Chain Signatures, and it signs a spend only after parsing the
transaction itself and checking it against one policy. The agent can ask for anything. The contract
decides what gets signed.

> **Status: early build.** The repo, contract skeleton, sandbox test and CI are in place. The
> adapters and `propose_spend` refuse every transaction until they're implemented, and nothing is
> deployed yet. Progress is tracked in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## How a spend works

1. The agent builds an unsigned transaction and calls `propose_spend`, using a function-call key that can't reach any owner method.
2. The contract parses the raw bytes with a per-chain adapter and computes the signing hash itself. It never accepts a hash from the caller.
3. The policy checks caps, payees, tokens, fees and chain ID.
4. Rejected spends are logged, large ones wait out a veto window, and the rest go to the MPC signer.

## Quick start

Requires Rust (via rustup), Node 22, pnpm 11 and gitleaks.

```sh
make setup   # install cargo-near and JS dependencies, create .env
make test    # build the wasm, then run Rust, sandbox and TypeScript tests
make help    # list every target
```

The `demo-*`, `deploy`, `veto`, `freeze` and `testnet-smoke` targets exit with an error naming the
milestone that delivers them.

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

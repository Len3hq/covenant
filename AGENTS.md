# AGENTS.md

Instructions for AI agents and new contributors.

## Read first

- [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md): what to do next, in order, and the spec corrections.
- [docs/SPEC.md](docs/SPEC.md): the detailed behaviour of every component.
- [docs/SPIKE.md](docs/SPIKE.md): measured behaviour of the live MPC signer.

## Commands

| Task | Command |
| --- | --- |
| Install tools and dependencies | `make setup` |
| Everything CI runs | `make check` |
| Build the contracts | `make wasm` (output in `target/near/`) |
| Show vault addresses | `make addresses` (needs `.env`) |
| Deploy to testnet | `make deploy` (needs `.env`, the NEAR CLI and the vault's key) |
| Publish the vault code and deploy the factory | `make deploy-factory` (needs `FACTORY_*` in `.env`, the NEAR CLI, and about 29 NEAR the first time) |
| Publish the dashboard to Railway | `make deploy-dashboard` (needs the railway CLI, logged in) |
| Build the SDK and MCP server | `pnpm --filter "@len3hq/covenant-mcp..." build` (outputs in `sdk/dist`, `mcp/dist`) |
| Check the npm packages install and run | `node scripts/pack-smoke.mjs` |
| Publish the SDK and MCP server to npm | Push a tag `vX.Y.Z` matching both versions (needs `NPM_TOKEN`; see docs/RUNBOOK.md) |
| Run the dashboard | `pnpm --filter @covenant/web dev`, then add `?vault=<account>` or `?create` |
| Update the live policy | `make set-policy` (needs the owner's key) |
| Veto a queued spend as owner | `make veto ID=<id>` |
| Freeze or unfreeze as owner | `make freeze`, `make unfreeze` |
| Replace the guardian | `make set-guardian GUARDIAN=<account>` |
| Veto or freeze by DAO vote | `make dao-veto ID=<id>`, `make dao-freeze` |
| Create the agent's restricted key | `make agent-key` |
| Keyless demo, all three scenarios | `make demo` (no `.env` needed) |
| One scenario live, with a real model | `make demo-attack LIVE=1 LLM=1` (needs `AGENT_PRIVATE_KEY` and the `LLM_*` settings) |
| Live end-to-end check | `make testnet-smoke` (spends tiny amounts) |
| Pay USDC from the vault | `make pay-usdc TO=<address> AMOUNT=<base units>` (needs `AGENT_PRIVATE_KEY`) |
| Pay BTC from the vault | `make pay-btc TO=<address> SATS=<amount>` (needs `AGENT_PRIVATE_KEY`) |
| Pay ETH from the vault | `make pay-eth TO=<address> WEI=<amount>` (needs `AGENT_PRIVATE_KEY`) |
| Create a Solana nonce account for the vault | `make sol-nonce` (writes `SOL_FUNDER_KEY` and `SOL_NONCE_ACCOUNTS` to `.env`; fund the funder at faucet.solana.com) |
| Pay SOL or Solana USDC from the vault | `make pay-sol TO=<address> AMOUNT=<lamports> [TOKEN=USDC]` (needs `AGENT_PRIVATE_KEY` and a nonce account) |
| Regenerate the test vectors | `pnpm --filter @covenant/scripts vectors` (expect no diff) |
| Rust tests, without the sandbox | `cargo test --workspace --exclude covenant-integration-tests` |
| Sandbox tests | `make wasm && cargo test -p covenant-integration-tests` |
| TypeScript | `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` |

Use `cargo near build`, not `cargo build`, for the contract. `near-sdk` refuses a plain wasm build.
Sandbox tests read the built wasm, so rebuild after any contract change.

## Rules

- All security logic lives in `contracts/`. Never add a security check to the agent or dashboard alone.
- No public contract method may accept a signing hash. The contract computes every hash it signs.
- Unimplemented code fails closed.
- Use `CovenantError` variant names verbatim in tests and docs.
- Integers only: sats, wei and token base units. Never floats. Amounts cross JSON as `U128` strings.
- Every security claim maps to a named test in [SECURITY.md](SECURITY.md).
- Never commit keys. `.env` stays local, and `gitleaks` runs on the full history in CI.
- Avoid dependencies with C code in the contract. They emit wasm the NEAR VM can reject.

## Workflow

Commit directly to `main`, with no feature branches or PRs, while one person runs the project. Use
conventional commit messages, and run `make check` before pushing.

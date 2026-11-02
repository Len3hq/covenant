# AGENTS.md

Instructions for AI agents and new contributors.

## Read first

- [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md): what to do next, in order, and the spec corrections.
- [docs/SPEC.md](docs/SPEC.md): the detailed behaviour of every component.

## Commands

| Task | Command |
| --- | --- |
| Install tools and dependencies | `make setup` |
| Everything CI runs | `make check` |
| Build the contract | `make wasm` (output in `target/near/covenant_vault/`) |
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

Branch `feat/<area>-<thing>` from `main`, squash merge, and use a conventional commit as the PR title.
The lead reviews every change to `contracts/`.

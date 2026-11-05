# Tests

| Folder | Contents | Status |
| --- | --- | --- |
| `integration/` | near-workspaces sandbox tests. Run `make wasm` first. | Access control, spends and the gas table |
| `mock-signer/` | Stand-in for the MPC signer in sandbox tests | Done |
| `vectors/` | BIP143 and EIP-1559 fixtures (JSON) | Starts at M1 |
| `attacks/` | Malicious-proposer suites, run with the integration tests | Bitcoin done; EVM at M8 |

The full list of named tests is in [docs/BUILD_PLAN.md](../docs/BUILD_PLAN.md#named-test-tracker).

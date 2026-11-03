# Tests

| Folder | Contents | Status |
| --- | --- | --- |
| `integration/` | near-workspaces sandbox tests. Run `make wasm` first. | Deploy and mock signer tests in place |
| `mock-signer/` | Stand-in for the MPC signer in sandbox tests | Done |
| `spike/` | Throwaway contract from the M0 signing spike | Delete at M3 |
| `vectors/` | BIP143 and EIP-1559 fixtures (JSON) | Starts at M1 |
| `attacks/` | Named malicious-proposer suites | Starts at M7 |

The full list of named tests is in [docs/BUILD_PLAN.md](../docs/BUILD_PLAN.md#named-test-tracker).

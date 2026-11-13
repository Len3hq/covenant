# Tests

| Folder | Contents | Status |
| --- | --- | --- |
| `integration/` | near-workspaces sandbox tests. Run `make wasm` first. | Access control, spends and the gas table |
| `mock-signer/` | Stand-in for the MPC signer in sandbox tests | Done |
| `vectors/` | BIP143 and EIP-1559 fixtures (JSON) | Starts at M1 |
| `attacks/` | Malicious-proposer suites, run with the integration tests | Bitcoin and EVM |

Every named test, and the security claim it proves, is listed in [SECURITY.md](../SECURITY.md#invariant-to-test-map).

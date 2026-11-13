# Tests

| Folder | Contents |
| --- | --- |
| `integration/` | near-workspaces sandbox tests: access control, spends, the queue, the factory and the gas table. Run `make wasm` first. |
| `mock-signer/` | Stand-in for the MPC signer in sandbox tests |
| `vectors/` | Fixtures (JSON) for Bitcoin BIP143 sighashes, EIP-1559 hashes, Solana messages, Tidepool quotes and hosted grants |
| `attacks/` | Malicious-proposer suites for Bitcoin, EVM, Solana and Tidepool swaps, run with the integration tests |

Every named test, and the security claim it proves, is listed in [SECURITY.md](../SECURITY.md#invariant-to-test-map).

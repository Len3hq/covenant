# Security

Unaudited hackathon code, for testnets only.

## Trust model

Written at milestone M8. See [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## Invariant to test map

Each row moves to "Passing" when all of its named tests pass in CI.

| Invariant | Tests | Status |
| --- | --- | --- |
| Only allow-listed payees (or Bitcoin change to self) receive funds | `btc_rejects_unlisted_output`, `btc_rejects_change_to_foreign_script`, `evm_rejects_unlisted_payee` | Passing |
| EVM: only native transfer or exact ERC-20 transfer | `evm_rejects_approve`, `evm_rejects_arbitrary_calldata`, `evm_rejects_eip7702_type4`, `prop_evm_only_two_shapes_sign` | Passing |
| Fees and gas bounded; chainId bound | `btc_rejects_fee_rate_above_cap`, `btc_blocks_split_fee_attack`, `evm_rejects_gas_cost_above_cap`, `evm_rejects_wrong_chain_id` | Passing |
| Contract signs only hashes it computed | `btc_sighash_matches_bip143_vectors`, `evm_hash_matches_viem`; `evm_spend_signs_the_hash_the_contract_computed`; no public method accepts a hash (code review) | Passing |
| Caps hold across proposals | `prop_daily_cap_never_exceeded`, `concurrent_proposals_respect_daily_cap`, `sign_failure_releases_reservation` | Passing |
| Large spends wait out the veto window | `queued_spend_not_executable_before_delay`, `vetoed_spend_cannot_execute`, `execute_rechecks_tightened_policy` | Passing |
| Agent can't escalate; freeze stops everything | `agent_key_cannot_call_set_policy`, `frozen_blocks_propose_and_execute`, `guardian_can_freeze_not_unfreeze` | Planned |

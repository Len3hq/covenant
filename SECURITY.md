# Security

Unaudited hackathon code, for testnets only.

## Trust model

Covenant assumes the AI agent is compromised, and that the agent's key may have leaked. It doesn't
assume the same of the owner or the MPC network. The contract on NEAR is the only thing that can
get a signature for the vault's Bitcoin and EVM addresses, and it computes every hash it signs.

### Who can do what

| Role | Account | Can | Can't |
| --- | --- | --- | --- |
| Agent | `agent.len3hq.testnet`, function-call key | Call `propose_spend` and `execute` | Change policy, freeze, veto, move NEAR, call another contract, attach a deposit (`agent_key_cannot_call_set_policy`) |
| Guardian | `covenant-guardian.sputnikv2.testnet`, a Sputnik DAO | Veto and freeze, by a council vote | Unfreeze, set policy, replace itself (`guardian_can_freeze_not_unfreeze`, `only_the_owner_can_replace_the_guardian`) |
| Owner | `owner.len3hq.testnet` | Set policy, veto, freeze, unfreeze, replace the guardian | Spend directly: it must go through the same checks |
| Vault account | `covenant.len3hq.testnet` | Hold the contract | Nothing else, once its full-access key is removed (planned for 13 Nov) |

### Vaults made by the factory

Anyone can create their own vault at `<name>.<factory>` from the dashboard. The factory
(`contracts/covenant-factory`) has no owner and no method that touches a vault after creating it.

- **The caller is the owner.** Nobody else, including us, gets a role
  (`factory_creates_a_working_vault_owned_by_the_caller`). The agent can't also be the owner or guardian
  (`refuses_an_agent_that_is_also_the_owner`, `refuses_an_agent_that_is_also_the_guardian`).
- **The code can't change.** The vault runs one global contract by hash and has no access keys
  (`factory_vault_has_no_keys_and_runs_the_shared_code`). The cost is that a bug can't be patched: its
  owner has to make a new vault and move the funds.
- **The addresses come from the signer, not the caller,** so a form can't strand funds on an address
  the vault can't spend from (`factory_gives_each_vault_its_own_addresses_from_the_signer`,
  `derives_the_published_addresses_for_a_known_key`).
- **A failed creation refunds the deposit** (`factory_refunds_when_the_name_is_taken`,
  `factory_refunds_when_the_signer_fails`), and only the factory can call its callbacks
  (`factory_callbacks_refuse_outside_callers`).
- **Dashboard labels aren't verified.** Each owner names their own payees, so a hostile vault can call
  an attacker "Acme". The dashboard says whether a vault is a standard one, but that says nothing about
  whether its owner is honest.

The factory's own full-access key is a remaining trust point until it's removed, as with the vault's
key: its holder could change what *new* vaults get, but not vaults that already exist.

### What a hijacked agent can still do

- **Pay listed payees, within the caps.** The policy allows these payments, so the contract can't
  tell them from honest ones. The caps bound the damage, and spends at or above `queue_at` wait
  for a veto.
- **Fill the queue.** Up to 16 large spends, each within the caps. A veto clears them.
- **Spend the agent key's gas allowance.** At most 1 NEAR; the allowance can't fund anything else.

In the live attack on 6 Nov, `gpt-4o-mini` followed hidden instructions in an invoice and tried to
send 600,000 sats to an attacker and approve the attacker for unlimited USDC. The contract refused
both ([EVIDENCE.md](EVIDENCE.md)).

### What the contract trusts

- **The MPC network** (`v1.signer-prod.testnet`). If it signed on its own, nothing here could stop
  it.
- **The owner's key.** It's one plain account. Whoever holds it can change every limit, so a real
  deployment needs a multisig.
- **The vault's full-access key, until it's removed.** Its holder could deploy different code.
  Removal is planned for 13 Nov, and the transaction will be listed here.
- **The adapters' parsing.** They are the reason a hash can't hide a different payment, so every
  rule has a named test and the parsers have property tests.

### Limits to know

- **A freeze can't recall a signature.** It stops new `sign` calls. A signature already requested
  can still land, and a partly failed join still publishes the signatures it produced
  ([SPIKE.md](docs/SPIKE.md)). The contract keeps a spend's reservation when signing fails during a
  freeze, so the budget stays charged (C11).
- **The contract signs, but doesn't broadcast.** It can't make a signed payment reach the chain, or
  guarantee that a queued Bitcoin spend's coins are still unspent when it's signed.
- **Fees are charged at their maximum.** An EVM spend is charged its gas limit times its maximum fee
  per gas, even when it pays less.
- **The keyless demo uses a mock signer.** `make demo` runs the real contract in a local sandbox,
  but its signatures aren't real and nothing is broadcast. The live runs in EVIDENCE.md use the real
  MPC network.
- **The agent spends the vault's own unconfirmed change.** Others' unconfirmed coins are refused,
  because their senders could replace them. This is the agent's choice; the contract doesn't see
  confirmations.
- **Unaudited.** For testnets only.

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
| Agent can't escalate; freeze stops everything | `agent_key_cannot_call_set_policy`, `frozen_blocks_propose_and_execute`, `guardian_can_freeze_not_unfreeze` | Passing |
| A factory vault belongs to its creator, can't change, and refunds on failure | the 7 tests in `tests/integration/tests/factory.rs`, and `derives_the_published_addresses_for_a_known_key` | Passing |
| A hijacked agent's attacks never reach the signer | the 13 tests in `tests/attacks/bitcoin.rs` and 14 in `tests/attacks/evm.rs` | Passing |

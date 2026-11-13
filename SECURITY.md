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
| Vault account | `covenant.len3hq.testnet` | Hold the contract. This first demo vault was deployed directly and still has one full-access key, which can redeploy its code | Vaults made by the factory have no keys at all (below) |

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

The factory account still has a full-access key. Its holder could change what *new* vaults get, but
not vaults that already exist.

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
- **The first demo vault's full-access key.** `covenant.len3hq.testnet` was deployed directly and
  keeps one, so its holder could deploy different code. The dashboard labels it "Not made by the
  factory" and warns about the key. Vaults made by the factory, such as `guava.vaults-v3.len3hq.testnet`,
  have no keys.
- **The adapters' parsing.** They are the reason a hash can't hide a different payment, so every
  rule has a named test and the parsers have property tests.

### Limits to know

- **A freeze can't recall a signature.** It stops new `sign` calls. A signature already requested
  can still land, and a partly failed join still publishes the signatures it produced
  ([SPIKE.md](docs/SPIKE.md)). The contract keeps a spend's reservation when signing fails during a
  freeze, so the budget stays charged.
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
- **A Solana message names no cluster.** Nothing in it says devnet or mainnet. It can only land
  where its nonce account exists with that nonce value, which ties it to one cluster in practice.
- **Solana token payees are token accounts.** The contract can't derive an associated token account
  without curve arithmetic, so the owner lists the payee's token account itself. The SDK and
  dashboard derive it from the payee's wallet.
- **Swap delivery is trusted to Tidepool.** The vault proves what it pays and where refunds go,
  but Tidepool holds each deposit until it pays out or refunds. Tidepool is a community-run testnet
  service, not part of NEAR, with one server and one maker, and its deposit addresses are custodial.
  Losses are bounded by the vault's caps and by Tidepool's own limits per swap. The maker key is
  pinned in the policy, so the owner must update it if Tidepool rotates it.
- **Unaudited.** For testnets only.

## Before any mainnet use

All of these must be done first. This list is a starting point, not a full security review.

- [ ] Get an independent audit of the contract and fix what it finds.
- [ ] Move `owner` and `guardian` to multisigs, with each signer on a hardware wallet.
- [ ] Create new mainnet accounts and keys. Reuse no testnet key.
- [ ] Hold server secrets in a secrets manager, not a `.env` file or the encrypted backup.
- [ ] Decide who may upgrade the contract, and how, before removing or handing over its full-access key.
- [ ] Configure mainnet values, and verify each one against its official source: MPC signer, chain IDs,
      token addresses, RPC URLs and Bitcoin API.
- [ ] Remove the hardcoded testnet address prefix in [vault.ts](web/src/vault.ts) and pass `bc` to
      `p2wpkhAddress` in [keys.ts](scripts/src/keys.ts).
- [ ] Rewrite the policy with deliberately low caps, and raise them only after the system has run safely.
- [ ] Add monitoring and alerts for frozen state, queued spends, low balances and failed signatures.
- [ ] Write an incident runbook: who freezes the vault, how funds are recovered and how keys are rotated.
- [ ] Rerun the full test suite and the attack scenarios against the mainnet configuration, using small
      amounts.
- [ ] Update this file, which currently says testnets only.

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
| Solana: only a durable-nonce message from the vault alone, moving SOL or a capped SPL token | `sol_accepts_system_transfer`, `sol_accepts_usdc_transfer_checked`, `sol_rejects_unknown_program`, `sol_rejects_token_2022`, `sol_rejects_spl_approve_and_close`, `sol_rejects_v0_with_lookup_tables`, `sol_rejects_missing_nonce_advance`, `sol_rejects_a_second_signer_or_readonly_payer`, `sol_rejects_transfer_from_another_account` | Passing |
| Solana: priority fees bounded, and the vault signs exactly the bytes it checked | `sol_rejects_priority_fee_above_cap`, `sol_signs_exactly_the_checked_message`, `prop_mutated_solana_message_never_pays_elsewhere`, `solana_spend_signs_the_message_the_contract_checked` | Passing |
| A vault from before Solana support moves to the new code without losing state, and refuses Solana until its owner allows it | `migrate_keeps_state_and_refuses_solana_until_the_owner_allows_it`, `policy_without_a_solana_fee_cap_refuses_solana` | Passing |
| Open payees: with `unlisted: Hold`, a payment to an address off the list is never signed before the longer `unlisted_veto_delay_ns` window, at any amount, and the owner or guardian can veto it | `unlisted_payee_is_always_held`, `execute_after_the_listed_window_is_still_too_early`, `hold_mode_queues_attacker_and_veto_returns_budget`, `btc_hold_mode_accepts_an_unlisted_output_as_a_payment`, `evm_hold_mode_accepts_an_unlisted_payee`, `sol_hold_mode_accepts_an_unlisted_payee` | Passing |
| Unlisted payees can't receive more than `unlisted_per_24h` per asset, even split across outputs or spends, and zero refuses them the asset | `unlisted_cap_counts_split_outputs`, `unlisted_daily_cap_is_enforced_across_spends`, `unlisted_cap_holds_across_spends`, `zero_unlisted_cap_refuses_the_asset`, `hold_mode_with_no_unlisted_cap_refuses_the_asset` | Passing |
| The unlisted rules add to the main caps, never replace them, and are checked again at `execute` against today's policy | `unlisted_cap_does_not_lift_the_main_caps`, `switching_back_to_refuse_blocks_a_held_spend_at_execute`, `set_policy_refuses_an_unlisted_window_shorter_than_the_listed_one` | Passing |
| Unlisted payees stay refused unless the owner opts in, including after migration | `refuse_mode_still_refuses`, `refuse_mode_is_the_default`, `a_policy_without_the_new_fields_refuses_unlisted`, `migrate_v3_keeps_state_and_refuses_unlisted_payees` | Passing |
| Swaps: a spend with a quote pays exactly `amountIn` to the deposit address the maker key signed, nothing else, and each quote pays once | `live_quote_verifies_and_names_its_deposit_and_recipient`, `one_flipped_byte_fails`, `the_old_scheme_fails`, `duplicate_key_json_fails`, `attack_pays_its_own_address_with_an_honest_quote`, `attack_deposits_more_than_the_quote`, `attack_changes_the_recipient_after_signing`, `attack_replays_a_used_quote` | Passing |
| Swaps: refunds can only return to the vault, and a quote can't carry fees, memos or forwarding to anyone else | `refund_not_to_vault_fails`, `attack_sends_the_refund_to_itself`, `memo_and_unknown_request_fields_fail`, `attack_adds_an_app_fee_to_itself`, `routing_other_than_chain_to_chain_fails`, `dry_quote_fails`, `flex_and_any_input_fail` | Passing |
| Swaps: only listed assets, within the policy's slippage and with time to deposit; the final recipient follows the payee rules; held swaps are rechecked at execute | `unlisted_assets_and_loose_slippage_fail`, `deadline_too_close_or_too_far_fails`, `attack_swaps_to_an_unlisted_destination_asset`, `swap_to_an_unlisted_recipient_follows_the_unlisted_rules`, `held_swap_rechecks_the_swap_rules_at_execute`, `swaps_are_refused_without_a_swap_section` | Passing |
| Only the owner can replace the agent, the agent can't also be owner or guardian, and a replaced agent can't propose | `only_the_owner_can_replace_the_agent`, `old_agent_rejected_after_set_agent` | Passing |
| An agent made from the dashboard has one key, scoped to its vault's `propose_spend` and `execute` with a 1 NEAR allowance, and no full-access key | `creates, funds and keys the account in one transaction, scoped to the vault` (web/src/agent.test.ts) | Passing |
| A hijacked agent's attacks never reach the signer | the 13 tests in `tests/attacks/bitcoin.rs`, 14 in `tests/attacks/evm.rs` and 15 in `tests/attacks/solana.rs` | Passing |

SHELL := /bin/bash
CARGO_NEAR_VERSION := 0.22.0
VAULT_MANIFEST := contracts/covenant-vault/Cargo.toml
MOCK_SIGNER_MANIFEST := tests/mock-signer/Cargo.toml

.DEFAULT_GOAL := help
.PHONY: help setup fmt lint wasm test build check addresses deploy set-policy pay-btc pay-eth demo demo-pay demo-attack demo-queue agent-key veto freeze unfreeze set-guardian dao-freeze dao-veto pay-usdc testnet-smoke

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-15s %s\n", $$1, $$2}'

setup: ## Install cargo-near and JS dependencies, and create .env
	@cargo near --version >/dev/null 2>&1 || cargo install cargo-near --version $(CARGO_NEAR_VERSION) --locked
	pnpm install --frozen-lockfile
	@test -f .env || cp .env.example .env

fmt: ## Format Rust code
	cargo fmt --all

lint: ## Lint Rust and TypeScript
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	pnpm -r lint

wasm: ## Build the vault and mock signer to target/near/
	cargo near build non-reproducible-wasm --manifest-path $(VAULT_MANIFEST)
	cargo near build non-reproducible-wasm --manifest-path $(MOCK_SIGNER_MANIFEST)

test: wasm ## Run all Rust, sandbox and TypeScript tests
	cargo test --workspace
	pnpm -r test

build: wasm ## Build the contract, agent and dashboard
	pnpm -r build

check: lint test build ## Run everything CI runs, except the secret scan
	gitleaks detect --no-banner

addresses: ## Print the vault's Bitcoin and EVM addresses
	node --env-file=.env scripts/src/derive-addresses.ts

deploy: wasm ## Deploy the vault to NEAR testnet (needs the near CLI and the vault's key)
	node --env-file=.env scripts/src/deploy.ts

agent-key: ## Create the agent's restricted key and save it to .env (needs the agent account's full key)
	node --env-file=.env scripts/src/create-agent-key.ts

set-policy: ## Apply scripts/policy.testnet.json to the deployed vault (needs the owner's key)
	node --env-file=.env scripts/src/set-policy.ts

pay-btc: ## Pay from the vault: make pay-btc TO=<address> SATS=<amount> (needs AGENT_PRIVATE_KEY)
	pnpm --filter @covenant/agent build
	node --env-file=.env agent/dist/pay-btc.js $(TO) $(SATS)

pay-eth: ## Pay from the vault: make pay-eth TO=<address> WEI=<amount> (needs AGENT_PRIVATE_KEY)
	pnpm --filter @covenant/agent build
	node --env-file=.env agent/dist/pay-eth.js $(TO) $(WEI)

pay-usdc: ## Pay USDC from the vault: make pay-usdc TO=<address> AMOUNT=<base units> (needs AGENT_PRIVATE_KEY)
	pnpm --filter @covenant/agent build
	node --env-file=.env agent/dist/pay-usdc.js $(TO) $(AMOUNT)

demo: demo-pay demo-attack demo-queue ## Run all three judge scenarios

demo-pay: ## Honest payment on both chains (milestone M7)
	@echo "demo-pay: not implemented yet, see M7 in docs/BUILD_PLAN.md" >&2; exit 1

demo-attack: ## Prompt-injected attack, refused by the contract (milestone M8)
	@echo "demo-attack: not implemented yet, see M8 in docs/BUILD_PLAN.md" >&2; exit 1

demo-queue: ## Large spend queued for veto (milestone M8)
	@echo "demo-queue: not implemented yet, see M8 in docs/BUILD_PLAN.md" >&2; exit 1

veto: ## Veto a queued spend: make veto ID=<spend id> [AS=<guardian account>]
	node --env-file=.env scripts/src/admin.ts veto $(ID)

freeze: ## Freeze the vault: make freeze [AS=<guardian account>]
	node --env-file=.env scripts/src/admin.ts freeze

unfreeze: ## Unfreeze the vault, which only the owner can do
	node --env-file=.env scripts/src/admin.ts unfreeze

dao-freeze: ## Freeze the vault through the guardian DAO, proposing and voting as its council member
	node --env-file=.env scripts/src/dao.ts freeze

dao-veto: ## Veto through the guardian DAO: make dao-veto ID=<spend id>
	node --env-file=.env scripts/src/dao.ts veto $(ID)

set-guardian: ## Replace the guardian: make set-guardian GUARDIAN=<account>
	node --env-file=.env scripts/src/admin.ts set-guardian $(GUARDIAN)

testnet-smoke: ## Pay tiny amounts on both chains and check a live refusal (needs AGENT_PRIVATE_KEY)
	pnpm --filter @covenant/agent build
	node --env-file=.env agent/dist/smoke.js

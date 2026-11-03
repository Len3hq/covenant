SHELL := /bin/bash
CARGO_NEAR_VERSION := 0.22.0
VAULT_MANIFEST := contracts/covenant-vault/Cargo.toml
MOCK_SIGNER_MANIFEST := tests/mock-signer/Cargo.toml

.DEFAULT_GOAL := help
.PHONY: help setup fmt lint wasm test build check addresses deploy demo demo-pay demo-attack demo-queue veto freeze testnet-smoke

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

demo: demo-pay demo-attack demo-queue ## Run all three judge scenarios

demo-pay: ## Honest payment on both chains (milestone M7)
	@echo "demo-pay: not implemented yet, see M7 in docs/BUILD_PLAN.md" >&2; exit 1

demo-attack: ## Prompt-injected attack, refused by the contract (milestone M8)
	@echo "demo-attack: not implemented yet, see M8 in docs/BUILD_PLAN.md" >&2; exit 1

demo-queue: ## Large spend queued for veto (milestone M8)
	@echo "demo-queue: not implemented yet, see M8 in docs/BUILD_PLAN.md" >&2; exit 1

veto: ## Veto a queued spend as owner (milestone M5)
	@echo "veto: not implemented yet, see M5 in docs/BUILD_PLAN.md" >&2; exit 1

freeze: ## Freeze the vault as owner or guardian (milestone M5)
	@echo "freeze: not implemented yet, see M5 in docs/BUILD_PLAN.md" >&2; exit 1

testnet-smoke: ## Propose one tiny spend on each chain (milestone M6)
	@echo "testnet-smoke: not implemented yet, see M6 in docs/BUILD_PLAN.md" >&2; exit 1

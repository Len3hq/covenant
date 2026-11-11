SHELL := /bin/bash
CARGO_NEAR_VERSION := 0.22.0
VAULT_MANIFEST := contracts/covenant-vault/Cargo.toml
MOCK_SIGNER_MANIFEST := tests/mock-signer/Cargo.toml
FACTORY_MANIFEST := contracts/covenant-factory/Cargo.toml
ENCLAVE_MANIFEST := hosted/enclave/Cargo.toml

.DEFAULT_GOAL := help
.PHONY: help setup fmt lint wasm test build check addresses deploy deploy-factory deploy-dashboard deploy-connector enclave set-policy pay-btc pay-eth demo demo-pay demo-attack demo-queue agent-key veto freeze unfreeze set-guardian dao-freeze dao-veto pay-usdc pay-sol pay-swap execute sol-nonce testnet-smoke

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
	cargo fmt --manifest-path $(ENCLAVE_MANIFEST) --check
	cargo clippy --manifest-path $(ENCLAVE_MANIFEST) --all-targets -- -D warnings
	pnpm -r lint

wasm: ## Build the vault, factory and mock signer to target/near/
	cargo near build non-reproducible-wasm --manifest-path $(VAULT_MANIFEST)
	cargo near build non-reproducible-wasm --manifest-path $(FACTORY_MANIFEST)
	cargo near build non-reproducible-wasm --manifest-path $(MOCK_SIGNER_MANIFEST)

test: wasm ## Run all Rust, sandbox and TypeScript tests
	cargo test --workspace
	cargo test --manifest-path $(ENCLAVE_MANIFEST)
	pnpm -r test

build: wasm ## Build the contract, agent and dashboard
	pnpm -r build

check: lint test build ## Run everything CI runs, except the secret scan
	gitleaks detect --no-banner

addresses: ## Print the vault's Bitcoin and EVM addresses
	node --env-file=.env scripts/src/derive-addresses.ts

deploy: wasm ## Deploy the vault to NEAR testnet (needs the near CLI and the vault's key)
	node --env-file=.env scripts/src/deploy.ts

deploy-factory: wasm ## Publish the vault code and deploy the factory (needs the near CLI and both accounts' keys)
	node --env-file=.env scripts/src/deploy-factory.ts

deploy-connector: ## Publish the hosted connector on Railway, from the committed tree (needs the railway CLI)
	hosted/connector/deploy.sh

enclave: ## Build the hosted connector's key holder for OutLayer, and print its SHA256
	hosted/enclave/build.sh

deploy-dashboard: ## Build and publish the dashboard on Railway (needs the railway CLI, logged in and linked)
	railway up --service dashboard --ci

agent-key: ## Create the agent's restricted key and save it to .env: make agent-key [ENV_FILE=.env.other] (needs the agent account's full key)
	ENV_FILE=$(or $(ENV_FILE),.env) node --env-file=$(or $(ENV_FILE),.env) scripts/src/create-agent-key.ts

set-policy: ## Apply a policy to the deployed vault: make set-policy [POLICY=scripts/policy.open.testnet.json] (needs the owner's key)
	node --env-file=.env scripts/src/set-policy.ts $(POLICY)

pay-btc: ## Pay from the vault: make pay-btc TO=<address> SATS=<amount> (needs AGENT_PRIVATE_KEY)
	pnpm --filter "@covenant/agent..." build
	node --env-file=.env agent/dist/pay-btc.js $(TO) $(SATS)

pay-eth: ## Pay from the vault: make pay-eth TO=<address> WEI=<amount> (needs AGENT_PRIVATE_KEY)
	pnpm --filter "@covenant/agent..." build
	node --env-file=.env agent/dist/pay-eth.js $(TO) $(WEI)

pay-usdc: ## Pay USDC from the vault: make pay-usdc TO=<address> AMOUNT=<base units> (needs AGENT_PRIVATE_KEY)
	pnpm --filter "@covenant/agent..." build
	node --env-file=.env agent/dist/pay-usdc.js $(TO) $(AMOUNT)

pay-sol: ## Pay on Solana devnet: make pay-sol TO=<address> AMOUNT=<lamports> [TOKEN=USDC] (needs AGENT_PRIVATE_KEY, SOL_NONCE_ACCOUNTS)
	pnpm --filter "@covenant/agent..." build
	node --env-file=.env agent/dist/pay-sol.js $(TO) $(AMOUNT) $(TOKEN)

pay-swap: ## Pay across chains through Tidepool: make pay-swap ASSET=BTC AMOUNT=20000 TO_CHAIN=solana TO_ASSET=USDC TO=<address> [REF=<reference>]
	pnpm --filter "@covenant/agent..." build
	node --env-file=.env agent/dist/pay-swap.js $(ASSET) $(AMOUNT) $(TO_CHAIN) $(TO_ASSET) $(TO) $(REF)

execute: ## Sign a held payment made with pay-swap or the MCP server, after its window: make execute ID=<spend id>
	pnpm --filter "@covenant/agent..." build
	node --env-file=.env agent/dist/execute.js $(ID)

sol-nonce: ## Create a durable nonce account the vault controls: make sol-nonce [ENV_FILE=.env.other] (funds it from SOL_FUNDER_KEY)
	ENV_FILE=$(or $(ENV_FILE),.env) node --env-file=$(or $(ENV_FILE),.env) scripts/src/create-nonce.ts

DEMO_FLAGS = $(if $(LIVE),--live) $(if $(LLM),--llm) $(if $(RECORD),--record)
DEMO_ENV = $(if $(wildcard .env),--env-file=.env)

demo: wasm ## All three scenarios on a local sandbox, with no keys. LIVE=1 for testnet, LLM=1 for a real model
	pnpm --filter "@covenant/agent..." build
	node $(DEMO_ENV) agent/dist/index.js all $(DEMO_FLAGS)

demo-pay: wasm ## Honest payments on both chains (same flags as demo)
	pnpm --filter "@covenant/agent..." build
	node $(DEMO_ENV) agent/dist/index.js pay $(DEMO_FLAGS)

demo-attack: wasm ## A poisoned invoice the contract refuses (same flags as demo)
	pnpm --filter "@covenant/agent..." build
	node $(DEMO_ENV) agent/dist/index.js attack $(DEMO_FLAGS)

demo-queue: wasm ## A large spend queued, then vetoed (same flags as demo)
	pnpm --filter "@covenant/agent..." build
	node $(DEMO_ENV) agent/dist/index.js queue $(DEMO_FLAGS)




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
	pnpm --filter "@covenant/agent..." build
	node --env-file=.env agent/dist/smoke.js

# Going to production

The steps to take Covenant from this repo to a hosted deployment, for anyone deploying it.

There are two stages:

1. **Hosted testnet demo.** This is what we ship for the hackathon: the same contract on testnet, with
   the agent on a server and the dashboard at a public URL.
2. **Mainnet.** Not planned. The contract is unaudited and [SECURITY.md](../SECURITY.md) limits it to
   testnets. Don't put real funds in it until the mainnet list below is complete.

[BUILD_PLAN.md](BUILD_PLAN.md) has the dates and owners. This file only lists what deployment needs.

## Who holds which key

Covenant's security claim is that the agent can't change its own limits, so these keys stay separate.
**Don't copy the key backup, `~/.near-credentials` or the local `.env` to a server.**

| Key | Lives in | Used for | On the server? |
| --- | --- | --- | --- |
| `agent` function-call key | Server secret: `AGENT_PRIVATE_KEY` | `propose_spend` and `execute` only | **Yes** |
| LLM API key | Server secret: `LLM_API_KEY` | The agent's model calls | **Yes** |
| `covenant` full-access key | Lead's machine, until removed (D6) | Deploying the contract | No |
| `owner` | Lead's machine | `set_policy`, unfreezing | No |
| `guardian` | Sputnik DAO | Veto and freeze | No |
| `len3hq` parent account | Lead's machine | Creating accounts | No |

A teammate who deploys the server needs the agent key and the LLM key. Send those through the shared
password manager, never through chat or the repo.

## Key backup

This creates one encrypted file in the project root. `*.enc` is gitignored, so it can't be committed by
accident, though `git add -f` would still add it. Run it from the project root and choose a long password:

```bash
tar -czf - -C ~ .near-credentials/testnet -C "$PWD" .env \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -out covenant-keys.enc
```

To restore it on a new machine, run this from the project root. It overwrites existing files with the
same names:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in covenant-keys.enc | tar -xzf - -C ~
mv ~/.env .env
```

A copy in the project folder doesn't survive losing the machine, so keep a second copy in cloud storage.
Make a new backup whenever a key changes.

## Stage 1: hosted testnet demo

### Before deploying

- [ ] Create the agent's function-call key: receiver `covenant.len3hq.testnet`, methods `propose_spend`
      and `execute`, allowance 1 NEAR.
- [ ] Confirm `agent_key_cannot_call_set_policy` passes.
- [ ] Replace the throwaway test payee in [policy.testnet.json](../scripts/policy.testnet.json) with the
      real payees, then run `make set-policy` from the lead's machine.
- [ ] Settle how judges get access (D5).
- [ ] Run `make check` and confirm CI is green on `main`.

### Contract

Run from the lead's machine, because it needs the vault key and the NEAR CLI:

```bash
make wasm
make deploy
```

- [ ] Deploy the final contract. Redeploying keeps the vault addresses, because they derive from the
      account name and paths.
- [ ] Apply D6 as the last contract step: remove the vault's full-access key or hand it to the owner
      multisig, and say which in SECURITY.md. **If the key is removed, the contract can't be redeployed**,
      so this comes last.

### Factory

Run from the lead's machine with `FACTORY_ACCOUNT_ID` and `FACTORY_PUBLISHER_ACCOUNT_ID` set:

```bash
make deploy-factory
```

- [ ] Fund the publisher. Publishing the 265 KB vault code as a global contract burned 26.54 NEAR in the
      sandbox. It's paid once per vault version, and it replaces paying about 2.65 NEAR per vault.
- [ ] Create the factory account and fund it with about 2.5 NEAR for its 204 KB of code.
- [ ] Set `VITE_FACTORY_ACCOUNT_ID` on the dashboard if it isn't the default.
- [ ] A new vault version means a new factory. Existing vaults stay on the code they were made with.

### Agent server

Requires Node 22 or later and pnpm.

- [ ] Set these variables, using [.env.example](../.env.example) as the reference:
  - **Secrets:** `AGENT_PRIVATE_KEY`, `LLM_API_KEY`
  - **Config:** `NEAR_NETWORK`, `NEAR_RPC_URL`, `VAULT_ACCOUNT_ID`, `AGENT_ACCOUNT_ID`,
    `MPC_SIGNER_ACCOUNT_ID`, `BTC_PATH`, `EVM_PATH`, `BTC_API_URL`, `EVM_CHAIN_ID`, `EVM_RPC_URL`,
    `USDC_ADDRESS`, `LLM_BASE_URL`, `LLM_MODEL`
- [ ] Put `agent/spends.json` on storage that survives restarts. It's what stops a restarted agent paying
      twice, so losing it risks a double payment.
- [ ] Build and start it: `pnpm -r build`, then `pnpm --filter @covenant/agent start`.

### Dashboard

The dashboard is a static site. Anything named `VITE_*` ends up in the public bundle, so **never give it
a secret**.

- [ ] Use a NEAR RPC that allows browser requests for `VITE_NEAR_RPC_URL`. `rpc.testnet.near.org` doesn't,
      so the default is `rpc.testnet.fastnear.com`.
- [ ] Set `VITE_NEAR_RPC_URL`, `VITE_VAULT_ACCOUNT_ID`, `VITE_BTC_API_URL`, `VITE_EVM_RPC_URL` and `VITE_NEAR_TX_API_URL`.
- [x] Hosted on Railway at https://covenant.len3.xyz (project `covenant` in the "realist's Projects" workspace, service
      `dashboard`). `make deploy-dashboard` uploads this folder, minus everything in `.railwayignore`, and
      builds [web/deploy/Dockerfile](../web/deploy/Dockerfile), which serves the static build with Caddy.
      The service variable `RAILWAY_DOCKERFILE_PATH` points at that Dockerfile, because Railway otherwise
      detects the Rust workspace and fails.
- [ ] To deploy on every push instead, connect the GitHub repo to the service in Railway's settings.

### Funding

Judges and screening tools run `make demo`, which spends nothing. Only live runs spend, and each
live `pay` scenario costs about 20,141 sats, 1 USDC, 0.0000004 ETH in gas and 0.001 NEAR of the agent
key's allowance. Measured on 6 Nov, the vault holds enough for:

| Asset | Held on 6 Nov | Live `pay` runs it covers | Daily cap allows |
| --- | --- | --- | --- |
| BTC | 657,782 sats | About 30 | About 99 a day |
| USDC | 18 USDC | 17 | 200 a day |
| ETH (gas) | 0.0000962 ETH | About 240 | Not the limit |
| Agent allowance | 0.97 NEAR | About 650 spends, keeping 0.3 NEAR spare | Not a cap |

- [ ] Base Sepolia: top up to about 0.05 ETH and 20 USDC before the recorded run.
- [ ] NEAR: the vault holds 4 NEAR, which covers its storage and the 1 yoctoNEAR per `sign`.
- [ ] A transaction needs about 0.3 NEAR of allowance left to pass the pessimistic gas check, so
      replace the agent key before its allowance falls to that.

### Going public

- [ ] Run `gitleaks detect` on the full history, then make the repo public by 12 Nov.
- [ ] From a fresh clone on a clean machine, run `make setup && make demo-pay`.

### During and after judging

- [ ] Keep the funds topped up and the demo key valid from 16 to 18 Nov.
- [ ] Rotate all keys only after judging ends (C8).

## Stage 2: mainnet

All of these must be done first. This list is a starting point, not a full security review.

- [ ] Get an independent audit of the contract and fix what it finds.
- [ ] Move `owner` and `guardian` to multisigs, with each signer on a hardware wallet.
- [ ] Create new mainnet accounts and keys. Reuse no testnet key.
- [ ] Hold server secrets in a secrets manager, not a `.env` file or the encrypted backup.
- [ ] Decide who may upgrade the contract, and how, before removing or handing over its full-access key.
- [ ] Configure mainnet values, and verify each one against its official source: MPC signer, chain IDs,
      token addresses, RPC URLs and Bitcoin API.
- [ ] Remove the hardcoded testnet address prefix in [vault.ts](../web/src/vault.ts) and pass `bc` to
      `p2wpkhAddress` in [keys.ts](../scripts/src/keys.ts).
- [ ] Rewrite the policy with deliberately low caps, and raise them only after the system has run safely.
- [ ] Add monitoring and alerts for frozen state, queued spends, low balances and failed signatures.
- [ ] Write an incident runbook: who freezes the vault, how funds are recovered and how keys are rotated.
- [ ] Rerun the full test suite and the attack scenarios against the mainnet configuration, using small
      amounts.
- [ ] Update SECURITY.md, which currently says testnets only.

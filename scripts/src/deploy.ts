import { hex } from "@scure/base";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { requireEnv, viewCall } from "./near.ts";
import { deriveVaultKeys, SOL_PATH } from "./vault-keys.ts";

const WASM = "target/near/covenant_vault/covenant_vault.wasm";
const POLICY = "scripts/policy.testnet.json";

function near(args: string[]) {
  execFileSync("near", args, { stdio: "inherit" });
}

/**
 * `null` when there's no vault yet; otherwise which state layout it runs: before Solana support,
 * before open payees, or current. Open payees added `unlisted` to the policy, which every current
 * vault's `get_policy` returns.
 */
async function deployed(
  rpcUrl: string,
  vault: string,
): Promise<{ hasSolana: boolean; hasOpenPayees: boolean } | null> {
  try {
    const addresses = await viewCall<{ sol_address?: string }>(rpcUrl, vault, "get_addresses", {});
    const policy = await viewCall<{ unlisted?: string }>(rpcUrl, vault, "get_policy", {});
    return { hasSolana: typeof addresses.sol_address === "string", hasOpenPayees: "unlisted" in policy };
  } catch {
    return null;
  }
}

function deployWithInit(vault: string, method: string, args: object, send: string[]) {
  near([
    "contract",
    "deploy",
    vault,
    "use-file",
    WASM,
    "with-init-call",
    method,
    "json-args",
    JSON.stringify(args),
    "prepaid-gas",
    "100 Tgas",
    "attached-deposit",
    "0 NEAR",
    ...send,
  ]);
}

const keys = await deriveVaultKeys();
const rpcUrl = requireEnv("NEAR_RPC_URL");
const network = requireEnv("NEAR_NETWORK");
const send = ["network-config", network, "sign-with-legacy-keychain", "send"];

// Redeploying keeps the vault addresses, because they derive from the account name and paths.
// An older vault is migrated in the same transaction, or its state would no longer read. Either
// migration needs an empty queue, and keeps Solana and unlisted payees refused until the owner
// sets a policy that allows them.
const current = await deployed(rpcUrl, keys.vault);
if (current?.hasOpenPayees) {
  near(["contract", "deploy", keys.vault, "use-file", WASM, "without-init-call", ...send]);
} else if (current?.hasSolana) {
  deployWithInit(keys.vault, "migrate_v3", {}, send);
} else if (current) {
  deployWithInit(keys.vault, "migrate", { sol_pubkey: [...keys.solPubkey] }, send);
} else {
  const initArgs = {
    owner: requireEnv("OWNER_ACCOUNT_ID"),
    guardian: process.env.GUARDIAN_ACCOUNT_ID || null,
    agent: requireEnv("AGENT_ACCOUNT_ID"),
    signer: requireEnv("MPC_SIGNER_ACCOUNT_ID"),
    paths: { btc: requireEnv("BTC_PATH"), evm: requireEnv("EVM_PATH"), sol: SOL_PATH },
    btc_pubkey: Buffer.from(keys.btcPubkey).toString("base64"),
    evm_address: [...hex.decode(keys.evmAddress.slice(2))],
    sol_pubkey: [...keys.solPubkey],
    policy: JSON.parse(readFileSync(POLICY, "utf8")) as unknown,
  };
  deployWithInit(keys.vault, "new", initArgs, send);
}

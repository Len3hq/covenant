import { hex } from "@scure/base";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { requireEnv, viewCall } from "./near.ts";
import { deriveVaultKeys } from "./vault-keys.ts";

const WASM = "target/near/covenant_vault/covenant_vault.wasm";
const POLICY = "scripts/policy.testnet.json";

function near(args: string[]) {
  execFileSync("near", args, { stdio: "inherit" });
}

async function isInitialized(rpcUrl: string, vault: string): Promise<boolean> {
  try {
    await viewCall<boolean>(rpcUrl, vault, "is_frozen", {});
    return true;
  } catch {
    return false;
  }
}

const keys = await deriveVaultKeys();
const rpcUrl = requireEnv("NEAR_RPC_URL");
const network = requireEnv("NEAR_NETWORK");
const send = ["network-config", network, "sign-with-legacy-keychain", "send"];

// Redeploying keeps the vault addresses, because they derive from the account name and paths.
if (await isInitialized(rpcUrl, keys.vault)) {
  near(["contract", "deploy", keys.vault, "use-file", WASM, "without-init-call", ...send]);
} else {
  const initArgs = {
    owner: requireEnv("OWNER_ACCOUNT_ID"),
    guardian: process.env.GUARDIAN_ACCOUNT_ID || null,
    agent: requireEnv("AGENT_ACCOUNT_ID"),
    signer: requireEnv("MPC_SIGNER_ACCOUNT_ID"),
    paths: { btc: requireEnv("BTC_PATH"), evm: requireEnv("EVM_PATH"), sol: "sol-vault-1" },
    btc_pubkey: Buffer.from(keys.btcPubkey).toString("base64"),
    evm_address: [...hex.decode(keys.evmAddress.slice(2))],
    policy: JSON.parse(readFileSync(POLICY, "utf8")) as unknown,
  };
  near([
    "contract",
    "deploy",
    keys.vault,
    "use-file",
    WASM,
    "with-init-call",
    "new",
    "json-args",
    JSON.stringify(initArgs),
    "prepaid-gas",
    "100 Tgas",
    "attached-deposit",
    "0 NEAR",
    ...send,
  ]);
}

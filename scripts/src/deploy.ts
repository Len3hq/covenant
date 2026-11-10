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

/** `null` when there's no vault yet; otherwise whether it already has its Solana key. */
async function deployed(rpcUrl: string, vault: string): Promise<{ hasSolana: boolean } | null> {
  try {
    const addresses = await viewCall<{ sol_address?: string }>(rpcUrl, vault, "get_addresses", {});
    return { hasSolana: typeof addresses.sol_address === "string" };
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
// A vault from before Solana support is migrated in the same transaction, or its state would no
// longer read; it needs an empty queue, and Solana stays refused until the owner sets a policy.
const current = await deployed(rpcUrl, keys.vault);
if (current?.hasSolana) {
  near(["contract", "deploy", keys.vault, "use-file", WASM, "without-init-call", ...send]);
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

// Publishes the vault code as a global contract, then deploys the factory that points at it. Run
// after `make wasm`. Publishing again with the same code does nothing new, but it costs the same,
// so it's skipped when the factory already points at this code.
import { base58 } from "@scure/base";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { requireEnv, viewCall } from "./near.ts";

const VAULT_WASM = "target/near/covenant_vault/covenant_vault.wasm";
const FACTORY_WASM = "target/near/covenant_factory/covenant_factory.wasm";

function near(args: string[]) {
  execFileSync("near", args, { stdio: "inherit" });
}

const factory = requireEnv("FACTORY_ACCOUNT_ID");
const publisher = requireEnv("FACTORY_PUBLISHER_ACCOUNT_ID");
const signer = requireEnv("MPC_SIGNER_ACCOUNT_ID");
const rpcUrl = requireEnv("NEAR_RPC_URL");
const network = requireEnv("NEAR_NETWORK");
const send = ["network-config", network, "sign-with-legacy-keychain", "send"];
const hash = base58.encode(createHash("sha256").update(readFileSync(VAULT_WASM)).digest());

const current = await viewCall<string>(rpcUrl, factory, "get_vault_code_hash", {}).catch(() => null);
if (current === hash) {
  console.log(`${factory} already points at ${hash}`);
  process.exit(0);
}
if (current !== null) {
  throw new Error(`${factory} is set to ${current}, and can't change. Use a new factory account.`);
}

near(["contract", "deploy-as-global", "use-file", VAULT_WASM, "as-global-hash", publisher, ...send]);
near([
  "contract",
  "deploy",
  factory,
  "use-file",
  FACTORY_WASM,
  "with-init-call",
  "new",
  "json-args",
  JSON.stringify({ signer, vault_code_hash: hash }),
  "prepaid-gas",
  "30 Tgas",
  "attached-deposit",
  "0 NEAR",
  ...send,
]);
console.log(`${factory} now creates vaults running ${hash}`);

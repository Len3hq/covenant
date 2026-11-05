// Gives the agent its restricted key: it can call only `propose_spend` and `execute` on the vault,
// and spend at most 1 NEAR on gas. The secret goes straight into .env and is never printed.
import { base58 } from "@scure/base";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { requireEnv } from "./near.ts";

const ENV_FILE = ".env";
const SEED_START = 16;
const PUBLIC_START = 12;

if (process.env.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY is already set in .env");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(SEED_START);
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(PUBLIC_START);

execFileSync(
  "near",
  [
    "account",
    "add-key",
    requireEnv("AGENT_ACCOUNT_ID"),
    "grant-function-call-access",
    "--allowance",
    "1 NEAR",
    "--contract-account-id",
    requireEnv("VAULT_ACCOUNT_ID"),
    "--function-names",
    "propose_spend, execute",
    "use-manually-provided-public-key",
    `ed25519:${base58.encode(raw)}`,
    "network-config",
    requireEnv("NEAR_NETWORK"),
    "sign-with-legacy-keychain",
    "send",
  ],
  { stdio: "inherit" },
);

const secret = `ed25519:${base58.encode(Buffer.concat([seed, raw]))}`;
const env = readFileSync(ENV_FILE, "utf8").replace(/^AGENT_PRIVATE_KEY=.*$/m, `AGENT_PRIVATE_KEY=${secret}`);
writeFileSync(ENV_FILE, env);
console.log(`Added ed25519:${base58.encode(raw)} and saved its secret to ${ENV_FILE}.`);

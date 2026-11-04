// Replaces the deployed vault's policy with scripts/policy.testnet.json, signed by the owner.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { requireEnv } from "./near.ts";

const policy = JSON.parse(readFileSync("scripts/policy.testnet.json", "utf8")) as unknown;

execFileSync(
  "near",
  [
    "contract",
    "call-function",
    "as-transaction",
    requireEnv("VAULT_ACCOUNT_ID"),
    "set_policy",
    "json-args",
    JSON.stringify({ policy }),
    "prepaid-gas",
    "30 Tgas",
    "attached-deposit",
    "0 NEAR",
    "sign-as",
    requireEnv("OWNER_ACCOUNT_ID"),
    "network-config",
    requireEnv("NEAR_NETWORK"),
    "sign-with-legacy-keychain",
    "send",
  ],
  { stdio: "inherit" },
);

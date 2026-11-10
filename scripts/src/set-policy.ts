// Replaces the deployed vault's policy with a policy file, signed by the owner. The file is the first
// argument, or scripts/policy.testnet.json.
import { readFileSync } from "node:fs";
import { callVault, requireEnv } from "./near.ts";

const file = process.argv[2] || "scripts/policy.testnet.json";
const policy = JSON.parse(readFileSync(file, "utf8")) as unknown;
console.log(`Applying ${file}`);

callVault(requireEnv("OWNER_ACCOUNT_ID"), "set_policy", { policy });

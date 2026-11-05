// Replaces the deployed vault's policy with scripts/policy.testnet.json, signed by the owner.
import { readFileSync } from "node:fs";
import { callVault, requireEnv } from "./near.ts";

const policy = JSON.parse(readFileSync("scripts/policy.testnet.json", "utf8")) as unknown;

callVault(requireEnv("OWNER_ACCOUNT_ID"), "set_policy", { policy });

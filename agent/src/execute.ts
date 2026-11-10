// Signs and broadcasts a held payment the SDK recorded, once its veto window has passed:
// `node --env-file=.env agent/dist/execute.js <spend id>`. Works for payments made with
// `make pay-swap` or the MCP server, which share the spends file.
import { Covenant } from "@len3hq/covenant-sdk";
import { requireEnv } from "./env.js";

const [id] = process.argv.slice(2);
if (!id) throw new Error("usage: execute <spend id>");
const nonces = process.env.SOL_NONCE_ACCOUNTS?.split(",").filter(Boolean);
const wallet = Covenant.connect({
  vault: requireEnv("VAULT_ACCOUNT_ID"),
  agentAccount: requireEnv("AGENT_ACCOUNT_ID"),
  agentKey: requireEnv("AGENT_PRIVATE_KEY"),
  ...(process.env.NEAR_RPC_URL ? { nearRpcUrl: process.env.NEAR_RPC_URL } : {}),
  ...(process.env.USDC_ADDRESS ? { usdc: process.env.USDC_ADDRESS } : {}),
  ...(nonces?.length ? { solNonceAccounts: nonces } : {}),
  spendsFile: process.env.SPENDS_FILE ?? "covenant-spends.json",
});
console.log(JSON.stringify(await wallet.execute(id), null, 2));

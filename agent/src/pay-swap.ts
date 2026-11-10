// Pays across chains through Tidepool:
// `node --env-file=.env agent/dist/pay-swap.js <BTC|ETH|USDC|SOL> <base units> <to chain> <to token> <recipient> [reference]`.
// Prints the result, then follows Tidepool's status until it ends or a few minutes pass.
import { Covenant, type Asset } from "@covenant/sdk";
import { requireEnv } from "./env.js";

const [asset, amount, toChain, toAsset, to, reference] = process.argv.slice(2);
if (!asset || !amount || !toChain || !toAsset || !to) {
  throw new Error("usage: pay-swap <BTC|ETH|USDC|SOL> <base units> <to chain> <to token> <recipient> [reference]");
}
const ref = reference ?? `swap-${Date.now()}`;
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
const print = (value: unknown) =>
  console.log(JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? `${v}` : v), 2));

const result = await wallet.pay({ asset: asset as Asset, to, amount: BigInt(amount), reference: ref, toChain, toAsset });
print(result);
if (result.status === "broadcast") {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const status = await wallet.swapStatus(ref);
    const state = status.swap?.status ?? "unknown";
    console.log(`Tidepool: ${state}`);
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(state) || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}
console.log(`Reference ${ref}. Check later with the MCP tool get_payment_status, or run this again with the same reference.`);

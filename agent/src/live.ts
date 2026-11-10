import { connectTestnet } from "@covenant/sdk";
import { requireEnv } from "./env.js";
import type { World } from "./runtime.js";

/** The live testnets, with the vault and agent key from the environment. */
export function liveWorld(): World {
  const nonces = (process.env.SOL_NONCE_ACCOUNTS ?? "").split(",").map((account) => account.trim());
  const { vault, mempool, chain, usdc, broadcast, reads, solana } = connectTestnet({
    vault: requireEnv("VAULT_ACCOUNT_ID"),
    agentAccount: requireEnv("AGENT_ACCOUNT_ID"),
    agentKey: requireEnv("AGENT_PRIVATE_KEY"),
    nearRpcUrl: requireEnv("NEAR_RPC_URL"),
    btcApiUrl: requireEnv("BTC_API_URL"),
    evmRpcUrl: requireEnv("EVM_RPC_URL"),
    evmChainId: Number(requireEnv("EVM_CHAIN_ID")),
    usdc: requireEnv("USDC_ADDRESS"),
    ...(process.env.SOL_RPC_URL ? { solRpcUrl: process.env.SOL_RPC_URL } : {}),
    solNonceAccounts: nonces.filter(Boolean),
  });
  return {
    name: "live",
    vault,
    mempool,
    chain,
    usdc,
    solana,
    spendsFile: process.env.SPENDS_FILE || "agent/spends.json",
    broadcast,
    reads,
    stop: () => undefined,
  };
}

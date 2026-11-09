import { connectTestnet } from "@covenant/sdk";
import { requireEnv } from "./env.js";
import type { World } from "./runtime.js";

/** The live testnets, with the vault and agent key from the environment. */
export function liveWorld(): World {
  const { vault, mempool, chain, usdc, broadcast, reads } = connectTestnet({
    vault: requireEnv("VAULT_ACCOUNT_ID"),
    agentAccount: requireEnv("AGENT_ACCOUNT_ID"),
    agentKey: requireEnv("AGENT_PRIVATE_KEY"),
    nearRpcUrl: requireEnv("NEAR_RPC_URL"),
    btcApiUrl: requireEnv("BTC_API_URL"),
    evmRpcUrl: requireEnv("EVM_RPC_URL"),
    evmChainId: Number(requireEnv("EVM_CHAIN_ID")),
    usdc: requireEnv("USDC_ADDRESS"),
  });
  return {
    name: "live",
    vault,
    mempool,
    chain,
    usdc,
    spendsFile: process.env.SPENDS_FILE || "agent/spends.json",
    broadcast,
    reads,
    stop: () => undefined,
  };
}

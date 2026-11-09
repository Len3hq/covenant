import { connectVault, type AgentVault } from "@covenant/sdk";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

export function connectVaultFromEnv(): AgentVault {
  return connectVault({
    rpcUrl: requireEnv("NEAR_RPC_URL"),
    vault: requireEnv("VAULT_ACCOUNT_ID"),
    agent: requireEnv("AGENT_ACCOUNT_ID"),
    agentKey: requireEnv("AGENT_PRIVATE_KEY"),
  });
}

import { connectVault, Covenant, type AgentVault, type Asset } from "@len3hq/covenant-sdk";

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

/**
 * The vault as a Covenant wallet, recording every payment in SPENDS_FILE (default
 * covenant-spends.json, as execute.js reads it), so a held payment can be executed later.
 */
export function walletFromEnv(): Covenant {
  const nonces = process.env.SOL_NONCE_ACCOUNTS?.split(",").map((a) => a.trim()).filter(Boolean);
  return Covenant.connect({
    vault: requireEnv("VAULT_ACCOUNT_ID"),
    agentAccount: requireEnv("AGENT_ACCOUNT_ID"),
    agentKey: requireEnv("AGENT_PRIVATE_KEY"),
    ...(process.env.NEAR_RPC_URL ? { nearRpcUrl: process.env.NEAR_RPC_URL } : {}),
    ...(process.env.BTC_API_URL ? { btcApiUrl: process.env.BTC_API_URL } : {}),
    ...(process.env.EVM_RPC_URL ? { evmRpcUrl: process.env.EVM_RPC_URL } : {}),
    ...(process.env.USDC_ADDRESS ? { usdc: process.env.USDC_ADDRESS } : {}),
    ...(process.env.SOL_RPC_URL ? { solRpcUrl: process.env.SOL_RPC_URL } : {}),
    ...(nonces?.length ? { solNonceAccounts: nonces } : {}),
    spendsFile: process.env.SPENDS_FILE ?? "covenant-spends.json",
  });
}

/**
 * One payment from the command line: `<address> <amount> [reference]`. Each run is a new payment
 * unless it names a reference; the same reference never pays twice.
 */
export async function payFromCli(asset: Asset, usage: string, args: string[]): Promise<void> {
  const [to, amount, reference] = args;
  if (!to || !amount || !/^\d+$/.test(amount)) throw new Error(`usage: ${usage}`);
  const ref = reference ?? `cli-${asset}-${Date.now()}`;
  const result = await walletFromEnv().pay({ asset, to, amount: BigInt(amount), reference: ref });
  console.log(JSON.stringify({ reference: ref, ...result }, (_, v: unknown) => (typeof v === "bigint" ? `${v}` : v), 2));
  if (result.status === "queued") {
    console.log(`Held for a veto. Once its wait ends, send it with: make execute ID=${result.id}`);
  }
}

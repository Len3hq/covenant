// Pays a Bitcoin address from the vault: `node --env-file=.env agent/dist/pay-btc.js <address> <sats>`.
import { Mempool } from "./bitcoin/mempool.js";
import { payBitcoin } from "./bitcoin/pay.js";
import { connectVault } from "./vault.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

const [to, sats] = process.argv.slice(2);
if (!to || !sats) throw new Error("usage: pay-btc <address> <sats>");

const result = await payBitcoin(
  {
    vault: connectVault({
      rpcUrl: requireEnv("NEAR_RPC_URL"),
      vault: requireEnv("VAULT_ACCOUNT_ID"),
      agent: requireEnv("AGENT_ACCOUNT_ID"),
      agentKey: requireEnv("AGENT_PRIVATE_KEY"),
    }),
    mempool: new Mempool(requireEnv("BTC_API_URL")),
  },
  to,
  BigInt(sats),
);
console.log(JSON.stringify(result, (_, value) => (typeof value === "bigint" ? `${value}` : value)));

// Pays a Bitcoin address from the vault: `node --env-file=.env agent/dist/pay-btc.js <address> <sats>`.
import { Mempool } from "./bitcoin/mempool.js";
import { payBitcoin } from "./bitcoin/pay.js";
import { connectVaultFromEnv, requireEnv } from "./env.js";

const [to, sats] = process.argv.slice(2);
if (!to || !sats) throw new Error("usage: pay-btc <address> <sats>");

const result = await payBitcoin(
  {
    vault: connectVaultFromEnv(),
    mempool: new Mempool(requireEnv("BTC_API_URL")),
  },
  to,
  BigInt(sats),
);
console.log(JSON.stringify(result, (_, value) => (typeof value === "bigint" ? `${value}` : value)));

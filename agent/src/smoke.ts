// Proves the live path: real signatures on both chains, and a live refusal. Spends tiny amounts, so
// it needs AGENT_PRIVATE_KEY and exits non-zero on any failure.
import { createPublicClient, getAddress, http } from "viem";
import { Mempool } from "@len3hq/covenant-sdk";
import { payBitcoin } from "@len3hq/covenant-sdk";
import { connectVaultFromEnv, requireEnv } from "./env.js";
import { payEth, payToken, type EvmChain } from "@len3hq/covenant-sdk";

const SATS = 1_000n;
const WEI = 1_000n;
const USDC_BASE_UNITS = 1n;
const UNLISTED_EVM = "0x000000000000000000000000000000000000dEaD";
const UNLISTED_BTC = "tb1qh2at4w46h2at4w46h2at4w46h2at4w46jvgsm3";

function report(check: string, result: object): void {
  const printable = (_: string, value: unknown) => (typeof value === "bigint" ? `${value}` : value);
  console.log(JSON.stringify({ check, ...result }, printable));
}

function expectBroadcast<T extends { status: string }>(check: string, result: T): T {
  report(check, result);
  if (result.status !== "broadcast") throw new Error(`${check}: not broadcast`);
  return result;
}

function expectRefused(check: string, result: { status: string; outcome?: object }): void {
  report(check, result);
  if (result.status !== "not_signed" || !result.outcome || !("Rejected" in result.outcome)) {
    throw new Error(`${check}: not refused`);
  }
}

const vault = connectVaultFromEnv();
const client = createPublicClient({ transport: http(requireEnv("EVM_RPC_URL")) });
const chain: EvmChain = {
  chainId: Number(requireEnv("EVM_CHAIN_ID")),
  pendingNonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
  fees: () => client.estimateFeesPerGas({ chain: null, type: "eip1559" }),
  estimateGas: ({ from, to, data }) => client.estimateGas({ account: from, to, data }),
  broadcast: (serializedTransaction) => client.sendRawTransaction({ serializedTransaction }),
};
const evm = { vault, chain };
const bitcoin = { vault, mempool: new Mempool(requireEnv("BTC_API_URL")) };
const evmPayee = getAddress(requireEnv("SMOKE_EVM_PAYEE"));
const btcPayee = requireEnv("SMOKE_BTC_PAYEE");

// Each EVM payment confirms before the next, so nonces can't collide.
async function confirm(result: { status: string; hash?: `0x${string}` }): Promise<void> {
  if (!result.hash) return;
  const receipt = await client.waitForTransactionReceipt({ hash: result.hash });
  if (receipt.status !== "success") throw new Error(`${result.hash} reverted`);
}

await confirm(expectBroadcast("eth", await payEth(evm, evmPayee, WEI)));
const usdc = getAddress(requireEnv("USDC_ADDRESS"));
await confirm(expectBroadcast("usdc", await payToken(evm, usdc, evmPayee, USDC_BASE_UNITS)));
expectBroadcast("btc", await payBitcoin(bitcoin, btcPayee, SATS));
expectRefused("eth_unlisted", await payEth(evm, getAddress(UNLISTED_EVM), WEI));
expectRefused("btc_unlisted", await payBitcoin(bitcoin, UNLISTED_BTC, SATS));
console.log("testnet smoke passed");

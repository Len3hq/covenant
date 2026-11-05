import { readFileSync } from "node:fs";
import { networks, payments } from "bitcoinjs-lib";
import { createPublicClient, erc20Abi, getAddress, http, type Address } from "viem";
import { Mempool } from "./bitcoin/mempool.js";
import { connectVaultFromEnv, requireEnv } from "./env.js";
import type { EvmChain } from "./evm/pay.js";
import { jsonLog } from "./log.js";
import { Payer, type SpendReport } from "./payer.js";
import { SpendStore } from "./store.js";
import { createTools } from "./tools.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url);
export const scenarioText = (name: string) => readFileSync(new URL(name, SCENARIOS), "utf8").trim();

export interface Spend {
  asset: string;
  report: SpendReport;
}

/** The agent's tools, wired to the live vault and chains from the environment. */
export function createRuntime(runId: string) {
  const vault = connectVaultFromEnv();
  const client = createPublicClient({ transport: http(requireEnv("EVM_RPC_URL")) });
  const mempool = new Mempool(requireEnv("BTC_API_URL"));
  const usdc = getAddress(requireEnv("USDC_ADDRESS"));
  const chain: EvmChain = {
    chainId: Number(requireEnv("EVM_CHAIN_ID")),
    pendingNonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    fees: () => client.estimateFeesPerGas({ chain: null, type: "eip1559" }),
    estimateGas: ({ from, to, data }) => client.estimateGas({ account: from, to, data }),
    broadcast: (serializedTransaction) => client.sendRawTransaction({ serializedTransaction }),
  };
  const evmAddress = async () => (await vault.evmAddress()) as Address;

  const spends: Spend[] = [];
  const payer = new Payer({
    vault,
    store: new SpendStore(process.env.SPENDS_FILE || "agent/spends.json"),
    log: jsonLog,
    broadcast: {
      bitcoin: (signedHex) => mempool.broadcast(signedHex),
      evm: async (signedHex) => {
        const hash = await chain.broadcast(signedHex);
        // Confirmed before the next payment, so its nonce can't collide with this one.
        await client.waitForTransactionReceipt({ hash });
        return hash;
      },
    },
  });

  const tools = createTools({
    vault,
    payer,
    chain,
    usdc,
    runId,
    bitcoin: { vault, mempool },
    onSpend: (asset, report) => spends.push({ asset, report }),
    reads: {
      async btcBalance() {
        const pubkey = await vault.btcPubkey();
        const own = payments.p2wpkh({ pubkey, network: networks.testnet }).address;
        if (!own) throw new Error("could not derive the vault address");
        const coins = await mempool.spendableUtxos(own);
        return coins.reduce((total, coin) => total + coin.value, 0n);
      },
      ethBalance: async () => client.getBalance({ address: await evmAddress() }),
      tokenBalance: async () =>
        client.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [await evmAddress()],
        }),
    },
  });
  return { tools, spends };
}

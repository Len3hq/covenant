// Pays USDC from the vault: `node --env-file=.env agent/dist/pay-usdc.js <address> <base units>`.
import { createPublicClient, getAddress, http } from "viem";
import { connectVaultFromEnv, requireEnv } from "./env.js";
import { payToken } from "./evm/pay.js";

const [to, amount] = process.argv.slice(2);
if (!to || !amount) throw new Error("usage: pay-usdc <address> <base units>");

const client = createPublicClient({ transport: http(requireEnv("EVM_RPC_URL")) });
const result = await payToken(
  {
    vault: connectVaultFromEnv(),
    chain: {
      chainId: Number(requireEnv("EVM_CHAIN_ID")),
      pendingNonce: (address) =>
        client.getTransactionCount({ address, blockTag: "pending" }),
      fees: () => client.estimateFeesPerGas({ chain: null, type: "eip1559" }),
      estimateGas: ({ from, to, data }) => client.estimateGas({ account: from, to, data }),
      broadcast: (serializedTransaction) => client.sendRawTransaction({ serializedTransaction }),
    },
  },
  getAddress(requireEnv("USDC_ADDRESS")),
  getAddress(to),
  BigInt(amount),
);
console.log(JSON.stringify(result));
if (result.status === "broadcast") {
  const receipt = await client.waitForTransactionReceipt({ hash: result.hash });
  console.log(JSON.stringify({ receipt: receipt.status, block: `${receipt.blockNumber}` }));
}

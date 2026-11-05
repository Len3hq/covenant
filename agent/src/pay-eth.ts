// Pays an EVM address from the vault: `node --env-file=.env agent/dist/pay-eth.js <address> <wei>`.
import { createPublicClient, getAddress, http } from "viem";
import { connectVaultFromEnv, requireEnv } from "./env.js";
import { payEth } from "./evm/pay.js";

const [to, wei] = process.argv.slice(2);
if (!to || !wei) throw new Error("usage: pay-eth <address> <wei>");

const client = createPublicClient({ transport: http(requireEnv("EVM_RPC_URL")) });
const result = await payEth(
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
  getAddress(to),
  BigInt(wei),
);
console.log(JSON.stringify(result));
if (result.status === "broadcast") {
  const receipt = await client.waitForTransactionReceipt({ hash: result.hash });
  console.log(JSON.stringify({ receipt: receipt.status, block: `${receipt.blockNumber}` }));
}

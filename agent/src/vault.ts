import { Account, getTransactionLastResult, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { z } from "zod";

const MAX_GAS = 300_000_000_000_000n;

const outcomeSchema = z.union([
  z.object({
    Signed: z.object({
      id: z.string(),
      signatures: z.array(
        z.object({
          big_r: z.object({ affine_point: z.string() }),
          s: z.object({ scalar: z.string() }),
        }),
      ),
    }),
  }),
  z.object({ Queued: z.object({ id: z.string(), executable_at: z.string() }) }),
  z.object({ Rejected: z.string() }),
]);

export type SpendOutcome = z.infer<typeof outcomeSchema>;

export interface BitcoinProposal {
  tx: Uint8Array;
  prevTxs: Uint8Array[];
}

export interface VaultClient {
  btcPubkey(): Promise<Uint8Array>;
  btcLimits(): Promise<{ maxInputs: number; maxFeeRate: bigint }>;
  proposeBitcoin(proposal: BitcoinProposal): Promise<{ outcome: SpendOutcome; nearTx: string }>;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export function connectVault(config: {
  rpcUrl: string;
  vault: string;
  agent: string;
  agentKey: string;
}): VaultClient {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const account = new Account(config.agent, provider, config.agentKey as KeyPairString);
  const view = <T>(method: string) =>
    provider.callFunction({ contractId: config.vault, method, args: {} }) as Promise<T>;

  return {
    async btcPubkey() {
      const { btc_pubkey } = await view<{ btc_pubkey: string }>("get_addresses");
      return Buffer.from(btc_pubkey, "hex");
    },
    async btcLimits() {
      const policy = await view<{ btc_max_inputs: number; btc_max_fee_rate: number }>("get_policy");
      return { maxInputs: policy.btc_max_inputs, maxFeeRate: BigInt(policy.btc_max_fee_rate) };
    },
    async proposeBitcoin({ tx, prevTxs }) {
      const result = await account.callFunctionRaw({
        contractId: config.vault,
        methodName: "propose_spend",
        args: {
          chain: "Bitcoin",
          tx: base64(tx),
          meta: { Bitcoin: { prev_txs: prevTxs.map(base64) } },
        },
        gas: MAX_GAS,
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
      return {
        outcome: outcomeSchema.parse(getTransactionLastResult(result)),
        nearTx: result.transaction.hash,
      };
    },
  };
}

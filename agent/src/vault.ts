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
          recovery_id: z.number(),
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

export interface Proposed {
  outcome: SpendOutcome;
  nearTx: string;
}

export interface VaultClient {
  btcPubkey(): Promise<Uint8Array>;
  btcLimits(): Promise<{ maxInputs: number; maxFeeRate: bigint }>;
  evmAddress(): Promise<string>;
  proposeBitcoin(proposal: BitcoinProposal): Promise<Proposed>;
  proposeEvm(tx: Uint8Array): Promise<Proposed>;
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

  const propose = async (args: Record<string, unknown>): Promise<Proposed> => {
    const result = await account.callFunctionRaw({
      contractId: config.vault,
      methodName: "propose_spend",
      args,
      gas: MAX_GAS,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    return {
      outcome: outcomeSchema.parse(getTransactionLastResult(result)),
      nearTx: result.transaction.hash,
    };
  };

  return {
    async btcPubkey() {
      const { btc_pubkey } = await view<{ btc_pubkey: string }>("get_addresses");
      return Buffer.from(btc_pubkey, "hex");
    },
    async btcLimits() {
      const policy = await view<{ btc_max_inputs: number; btc_max_fee_rate: number }>("get_policy");
      return { maxInputs: policy.btc_max_inputs, maxFeeRate: BigInt(policy.btc_max_fee_rate) };
    },
    async evmAddress() {
      const { evm_address } = await view<{ evm_address: string }>("get_addresses");
      return evm_address;
    },
    proposeBitcoin: ({ tx, prevTxs }) =>
      propose({
        chain: "Bitcoin",
        tx: base64(tx),
        meta: { Bitcoin: { prev_txs: prevTxs.map(base64) } },
      }),
    proposeEvm: (tx) => propose({ chain: "Evm", tx: base64(tx), meta: "Evm" }),
  };
}

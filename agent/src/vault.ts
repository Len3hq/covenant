import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import {
  Account,
  actions,
  encodeTransaction,
  getTransactionLastResult,
  JsonRpcProvider,
  type FinalExecutionOutcome,
  type KeyPairString,
} from "near-api-js";
import { z } from "zod";
import { withRetry } from "./retry.js";

const MAX_GAS = 300_000_000_000_000n;
/** docs/SPEC.md: a signature that hasn't arrived by now is looked up, not proposed again. */
const SIGN_WAIT_MS = 60_000;
const RECOVER_TIMEOUT_MS = 120_000;
const RECOVER_POLL_MS = 3_000;

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

/** Called with a transaction's hash before it's sent, so a crash can't lose track of it. */
export type BeforeSend = (nearTx: string) => void;

export interface VaultClient {
  btcPubkey(): Promise<Uint8Array>;
  btcLimits(): Promise<{ maxInputs: number; maxFeeRate: bigint }>;
  evmAddress(): Promise<string>;
  proposeBitcoin(proposal: BitcoinProposal, beforeSend?: BeforeSend): Promise<Proposed>;
  proposeEvm(tx: Uint8Array, beforeSend?: BeforeSend): Promise<Proposed>;
}

export interface PolicyPayee {
  chain: "Bitcoin" | "Evm" | "Solana";
  to: number[];
  label: string;
}

export interface QueuedSpend {
  id: string;
  executable_at: string;
}

/** What the agent needs beyond paying: reading state and following up on queued spends. */
export interface AgentVault extends VaultClient {
  payees(): Promise<PolicyPayee[]>;
  spent24h(asset: unknown): Promise<string>;
  queue(): Promise<QueuedSpend[]>;
  execute(id: string, beforeSend?: BeforeSend): Promise<Proposed>;
  /** Finds the outcome of a transaction already sent, by its hash. Never sends anything. */
  recover(nearTx: string): Promise<Proposed>;
}

/** A contract panic means nothing changed, so the caller may safely try again. */
export class ContractPanic extends Error {}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export function connectVault(config: {
  rpcUrl: string;
  vault: string;
  agent: string;
  agentKey: string;
}): AgentVault {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const account = new Account(config.agent, provider, config.agentKey as KeyPairString);
  const view = <T>(method: string, args: Record<string, unknown> = {}) =>
    withRetry(() => provider.callFunction({ contractId: config.vault, method, args })) as Promise<T>;

  const toProposed = (result: FinalExecutionOutcome, nearTx: string): Proposed => {
    const { status } = result;
    if (typeof status === "object" && "Failure" in status && status.Failure) {
      throw new ContractPanic(JSON.stringify(status.Failure));
    }
    return { outcome: outcomeSchema.parse(getTransactionLastResult(result)), nearTx };
  };

  const recover = async (nearTx: string): Promise<Proposed> => {
    const deadline = Date.now() + RECOVER_TIMEOUT_MS;
    for (;;) {
      try {
        const result = await provider.viewTransactionStatus({
          txHash: nearTx,
          accountId: config.agent,
          waitUntil: "EXECUTED_OPTIMISTIC",
        });
        return toProposed(result as FinalExecutionOutcome, nearTx);
      } catch (error) {
        if (error instanceof ContractPanic || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, RECOVER_POLL_MS));
      }
    }
  };

  const send = async (
    method: string,
    args: Record<string, unknown>,
    beforeSend?: BeforeSend,
  ): Promise<Proposed> => {
    const signed = await account.createSignedTransaction({
      receiverId: config.vault,
      actions: [actions.functionCall(method, args, MAX_GAS, 0n)],
    });
    const nearTx = base58.encode(sha256(encodeTransaction(signed.transaction)));
    beforeSend?.(nearTx);
    try {
      const result = await Promise.race([
        provider.sendTransactionUntil(signed, "EXECUTED_OPTIMISTIC"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("no result yet")), SIGN_WAIT_MS).unref(),
        ),
      ]);
      return toProposed(result as FinalExecutionOutcome, nearTx);
    } catch (error) {
      if (error instanceof ContractPanic) throw error;
      // The transaction may still land, so it's looked up by hash rather than proposed again.
      return recover(nearTx);
    }
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
    proposeBitcoin: ({ tx, prevTxs }, beforeSend) =>
      send(
        "propose_spend",
        {
          chain: "Bitcoin",
          tx: base64(tx),
          meta: { Bitcoin: { prev_txs: prevTxs.map(base64) } },
        },
        beforeSend,
      ),
    proposeEvm: (tx, beforeSend) =>
      send("propose_spend", { chain: "Evm", tx: base64(tx), meta: "Evm" }, beforeSend),
    async payees() {
      return (await view<{ payees: PolicyPayee[] }>("get_policy")).payees;
    },
    spent24h: (asset) => view<string>("get_spent_24h", { asset }),
    queue: () => view<QueuedSpend[]>("get_queue"),
    execute: (id, beforeSend) => send("execute", { id }, beforeSend),
    recover,
  };
}

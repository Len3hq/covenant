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
import { RemoteNearSigner, type RemoteSigner } from "./signer.js";
import type { SignedQuote } from "./tidepool.js";

const MAX_GAS = 300_000_000_000_000n;
/** A signature that hasn't arrived by now is looked up, not proposed again. */
const SIGN_WAIT_MS = 60_000;
const RECOVER_TIMEOUT_MS = 120_000;
const RECOVER_POLL_MS = 3_000;

const ecdsaSchema = z.object({
  big_r: z.object({ affine_point: z.string() }),
  s: z.object({ scalar: z.string() }),
  recovery_id: z.number(),
});
const eddsaSchema = z.object({
  scheme: z.literal("Ed25519"),
  signature: z.array(z.number().int().min(0).max(255)),
});

/** A Bitcoin or EVM signature. */
export type EcdsaSignature = z.infer<typeof ecdsaSchema>;
/** A Solana signature over the whole message. */
export type EddsaSignature = z.infer<typeof eddsaSchema>;
export type VaultSignature = EcdsaSignature | EddsaSignature;

/** Bitcoin and EVM spends are signed with secp256k1; an Ed25519 one is a mismatch to stop on. */
export function ecdsa(signatures: VaultSignature[]): EcdsaSignature[] {
  return signatures.map((signature) => {
    if ("signature" in signature) throw new Error("expected a secp256k1 signature, got Ed25519");
    return signature;
  });
}

const outcomeSchema = z.union([
  z.object({
    Signed: z.object({
      id: z.string(),
      signatures: z.array(z.union([eddsaSchema, ecdsaSchema])),
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

/** The swap rules of a vault's policy, which a swap's quote must meet. */
export interface SwapRules {
  maker_key: number[];
  origins: { asset_id: string; asset: unknown }[];
  destinations: string[];
  payees: { destination_asset: string; recipient: string; label: string }[];
  max_slippage_bps: number;
  min_deposit_window_ns: number;
}

/** What the SDK needs to time a quote: the veto windows, and the swap rules if any. */
export interface Timing {
  veto_delay_ns: number;
  unlisted?: "Refuse" | "Hold";
  unlisted_veto_delay_ns?: number;
  swap?: SwapRules | null;
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
  /** The vault's Ed25519 key, whose base58 is its Solana address. */
  solPubkey(): Promise<Uint8Array>;
  /** `quote` pays a swap: the spend must pay exactly its deposit, and nothing else. */
  proposeBitcoin(proposal: BitcoinProposal, beforeSend?: BeforeSend, quote?: SignedQuote): Promise<Proposed>;
  proposeEvm(tx: Uint8Array, beforeSend?: BeforeSend, quote?: SignedQuote): Promise<Proposed>;
  proposeSolana(message: Uint8Array, beforeSend?: BeforeSend, quote?: SignedQuote): Promise<Proposed>;
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
  timing(): Promise<Timing>;
  spent24h(asset: unknown): Promise<string>;
  queue(): Promise<QueuedSpend[]>;
  execute(id: string, beforeSend?: BeforeSend): Promise<Proposed>;
  /** Finds the outcome of a transaction already sent, by its hash. Never sends anything. */
  recover(nearTx: string): Promise<Proposed>;
}

/** A contract panic means nothing changed, so the caller may safely try again. */
export class ContractPanic extends Error {}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** The agent's key: its secret, or a signer that holds it elsewhere. Exactly one. */
export type AgentKeyOption = { agentKey: string; signer?: never } | { signer: RemoteSigner; agentKey?: never };

export function connectVault(config: { rpcUrl: string; vault: string; agent: string } & AgentKeyOption): AgentVault {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const signer = config.signer ? new RemoteNearSigner(config.signer) : (config.agentKey as KeyPairString);
  const account = new Account(config.agent, provider, signer);
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
    async solPubkey() {
      const { sol_address } = await view<{ sol_address?: string }>("get_addresses");
      if (!sol_address) throw new Error(`${config.vault} runs code from before Solana support`);
      return base58.decode(sol_address);
    },
    proposeBitcoin: ({ tx, prevTxs }, beforeSend, quote) =>
      send(
        "propose_spend",
        {
          chain: "Bitcoin",
          tx: base64(tx),
          meta: { Bitcoin: { prev_txs: prevTxs.map(base64) } },
          ...(quote ? { quote } : {}),
        },
        beforeSend,
      ),
    proposeEvm: (tx, beforeSend, quote) =>
      send("propose_spend", { chain: "Evm", tx: base64(tx), meta: "Evm", ...(quote ? { quote } : {}) }, beforeSend),
    proposeSolana: (message, beforeSend, quote) =>
      send(
        "propose_spend",
        { chain: "Solana", tx: base64(message), meta: "Solana", ...(quote ? { quote } : {}) },
        beforeSend,
      ),
    async payees() {
      return (await view<{ payees: PolicyPayee[] }>("get_policy")).payees;
    },
    timing: () => view<Timing>("get_policy"),
    spent24h: (asset) => view<string>("get_spent_24h", { asset }),
    queue: () => view<QueuedSpend[]>("get_queue"),
    execute: (id, beforeSend) => send("execute", { id }, beforeSend),
    recover,
  };
}

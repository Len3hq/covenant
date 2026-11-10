import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, hex } from "@scure/base";
import type { Prepared } from "../store.js";
import type { VaultSignature } from "../vault.js";
import {
  advanceNonce,
  associatedTokenAccount,
  compileMessage,
  serializeTransaction,
  transfer,
  transferChecked,
  type Instruction,
} from "./message.js";
import type { SolanaRpc } from "./rpc.js";

export type SolanaPrepared = Extract<Prepared, { chain: "Solana" }>;

/** Devnet USDC has 6 decimals, like USDC everywhere. */
export const SOL_USDC_DECIMALS = 6;

export interface SolanaDeps {
  rpc: Pick<SolanaRpc, "nonce" | "isTokenAccount">;
  /** The vault's Ed25519 key, which is its Solana address. */
  vaultKey(): Promise<Uint8Array>;
  /**
   * Durable nonce accounts whose authority is the vault. Each unfinished payment holds one, because
   * any other message that advances it would make the held one invalid.
   */
  nonceAccounts: string[];
  usdcMint: Uint8Array;
  /** Nonce accounts an unfinished spend holds, which this payment must not use. */
  heldNonces?: () => Set<string>;
}

export function solanaKey(address: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = base58.decode(address.trim());
  } catch {
    throw new Error(`"${address}" isn't a Solana address`);
  }
  if (key.length !== 32) throw new Error(`"${address}" isn't a Solana address`);
  return key;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Builds the unsigned message: advance a free nonce account, then one transfer. For USDC, a wallet
 * address becomes its associated token account, which must already exist; the vault can't create
 * accounts.
 */
export async function prepareSolana(
  deps: SolanaDeps,
  asset: "SOL" | "USDC-SOL",
  destination: string,
  amount: bigint,
): Promise<SolanaPrepared> {
  const vault = await deps.vaultKey();
  const held = deps.heldNonces?.() ?? new Set<string>();
  const nonceAccount = deps.nonceAccounts.find((account) => !held.has(account));
  if (!nonceAccount) {
    throw new Error(
      deps.nonceAccounts.length === 0
        ? "no Solana nonce account is configured; create one with `make sol-nonce`"
        : "every Solana nonce account is held by an unfinished payment; add another with `make sol-nonce`",
    );
  }
  const nonceKey = solanaKey(nonceAccount);
  const state = await deps.rpc.nonce(nonceKey);
  if (!same(state.authority, vault)) {
    throw new Error(`nonce account ${nonceAccount} belongs to ${base58.encode(state.authority)}, not the vault`);
  }

  const to = solanaKey(destination);
  const payment: Instruction =
    asset === "SOL"
      ? transfer(vault, to, amount)
      : transferChecked(
          associatedTokenAccount(vault, deps.usdcMint),
          deps.usdcMint,
          (await deps.rpc.isTokenAccount(to)) ? to : associatedTokenAccount(to, deps.usdcMint),
          vault,
          amount,
          SOL_USDC_DECIMALS,
        );
  const message = compileMessage(vault, state.nonce, [advanceNonce(nonceKey, vault), payment]);
  return { chain: "Solana", unsignedHex: hex.encode(message), nonceAccount };
}

/** Adds the vault's signature, checked against its key, and returns what to broadcast. */
export function signSolana(
  prepared: SolanaPrepared,
  signatures: VaultSignature[],
  vaultKey: Uint8Array,
): { signedHex: string; chainTx: string } {
  const [signature] = signatures;
  if (!signature || signatures.length !== 1 || !("signature" in signature)) {
    throw new Error(`expected 1 Ed25519 signature, got ${JSON.stringify(signatures)}`);
  }
  const bytes = Uint8Array.from(signature.signature);
  const message = hex.decode(prepared.unsignedHex);
  if (bytes.length !== 64 || !ed25519.verify(bytes, message, vaultKey)) {
    throw new Error("the signature doesn't verify against the vault's Solana key");
  }
  return {
    signedHex: hex.encode(serializeTransaction([bytes], message)),
    // A Solana transaction is named by its first signature.
    chainTx: base58.encode(bytes),
  };
}

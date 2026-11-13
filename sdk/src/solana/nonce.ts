import { ed25519 } from "@noble/curves/ed25519.js";
import { compileMessage, createAccount, initializeNonce, NONCE_ACCOUNT_LEN, serializeTransaction, SYSTEM_PROGRAM } from "./message.js";

/*
 * Creates the durable nonce accounts a vault's Solana payments advance, so a payment held for a veto
 * can still land when its wait ends. A funder pays the rent and the fee; the nonce's authority is
 * the vault, so the funder can never use it, and the vault's own key never pays for anything.
 */

/** Lamports kept above the rent for the transaction's fee. */
export const NONCE_SETUP_FEES = 20_000n;

/** An Ed25519 key in Solana's 64-byte form: the 32-byte seed, then the public key. */
export interface SolanaKeypair {
  seed: Uint8Array;
  publicKey: Uint8Array;
}

export function solanaKeypair(seed: Uint8Array = ed25519.utils.randomSecretKey()): SolanaKeypair {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  return { seed, publicKey: ed25519.getPublicKey(seed) };
}

/** Reads Solana's 64-byte secret key, as the Solana CLI and wallets export it. */
export function solanaKeypairFromSecret(secret: Uint8Array): SolanaKeypair {
  if (secret.length !== 64) throw new Error("a Solana secret key is 64 bytes: seed, then public key");
  const keypair = solanaKeypair(secret.slice(0, 32));
  if (keypair.publicKey.some((byte, i) => byte !== secret[32 + i])) {
    throw new Error("this Solana secret key's public half doesn't match its seed");
  }
  return keypair;
}

export const solanaSecret = (keypair: SolanaKeypair): Uint8Array => Uint8Array.from([...keypair.seed, ...keypair.publicKey]);

/** The funder holds too little: send it `needed - has` lamports, then try again. */
export class NeedsFunding extends Error {
  constructor(
    readonly funder: Uint8Array,
    readonly has: bigint,
    readonly needed: bigint,
  ) {
    super(`the funder holds ${has} lamports and needs ${needed}`);
  }
}

/** The Solana RPC calls this needs; `SolanaRpc` has them all. */
export interface NonceSetupRpc {
  rentExempt(space: number): Promise<bigint>;
  balance(address: Uint8Array): Promise<bigint>;
  latestBlockhash(): Promise<Uint8Array>;
  sendAndConfirm(transaction: Uint8Array): Promise<string>;
}

/** The signed transaction that creates `nonce` with `authority` as its authority. */
export function nonceAccountTransaction(
  funder: SolanaKeypair,
  nonce: SolanaKeypair,
  authority: Uint8Array,
  rent: bigint,
  blockhash: Uint8Array,
): Uint8Array {
  const message = compileMessage(funder.publicKey, blockhash, [
    createAccount(funder.publicKey, nonce.publicKey, rent, NONCE_ACCOUNT_LEN, SYSTEM_PROGRAM),
    initializeNonce(nonce.publicKey, authority),
  ]);
  // The fee payer signs first, then the new account, as compileMessage orders the signers.
  return serializeTransaction([ed25519.sign(message, funder.seed), ed25519.sign(message, nonce.seed)], message);
}

/** Creates one nonce account whose authority is the vault. Throws `NeedsFunding` first if short. */
export async function createNonceAccount(
  rpc: NonceSetupRpc,
  funder: SolanaKeypair,
  authority: Uint8Array,
  nonce: SolanaKeypair = solanaKeypair(),
): Promise<{ account: Uint8Array; signature: string }> {
  const rent = await rpc.rentExempt(NONCE_ACCOUNT_LEN);
  const needed = rent + NONCE_SETUP_FEES;
  const has = await rpc.balance(funder.publicKey);
  if (has < needed) throw new NeedsFunding(funder.publicKey, has, needed);
  const transaction = nonceAccountTransaction(funder, nonce, authority, rent, await rpc.latestBlockhash());
  return { account: nonce.publicKey, signature: await rpc.sendAndConfirm(transaction) };
}

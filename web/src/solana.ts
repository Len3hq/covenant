import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import type { Payment } from "./vault";

/*
 * Solana helpers for display and for building the create form's policy. Nothing here decides
 * anything: the contract parses every message itself.
 */

const TOKEN_PROGRAM = base58.decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = base58.decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = new Uint8Array(32);

/** Circle's devnet USDC. */
export const SOL_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** A Solana address as 32 bytes, or an error naming what's wrong with it. */
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

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

/** The wallet's associated token account for a classic SPL mint, which is where its tokens go. */
export function associatedTokenAccount(wallet: Uint8Array, mint: Uint8Array): Uint8Array {
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const seeds = [...wallet, ...TOKEN_PROGRAM, ...mint, bump, ...ASSOCIATED_TOKEN_PROGRAM, ...marker];
    const hash = sha256(Uint8Array.from(seeds));
    if (!onCurve(hash)) return hash;
  }
  throw new Error("no associated token account");
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

function shortVec(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) throw new Error("short message");
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return [value, at + i + 1];
  }
  throw new Error("bad length");
}

const u64 = (bytes: Uint8Array) => bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);

/** The SOL and SPL transfers in a legacy message, as payments. */
export function solanaPayments(message: Uint8Array): Payment[] {
  if ((message[0] ?? 0x80) & 0x80) return [];
  let [count, at] = shortVec(message, 3);
  const keys: Uint8Array[] = [];
  for (let i = 0; i < count; i++, at += 32) keys.push(message.subarray(at, at + 32));
  at += 32;
  [count, at] = shortVec(message, at);
  const payments: Payment[] = [];
  for (let i = 0; i < count; i++) {
    const program = keys[message[at] ?? 0];
    let accounts: number;
    [accounts, at] = shortVec(message, at + 1);
    const indices = [...message.subarray(at, at + accounts)];
    at += accounts;
    let length: number;
    [length, at] = shortVec(message, at);
    const data = message.subarray(at, at + length);
    at += length;
    const key = (n: number) => keys[indices[n] ?? -1];
    if (program && same(program, SYSTEM_PROGRAM) && data.length === 12 && data[0] === 2) {
      const to = key(1);
      if (to) payments.push({ asset: "Sol", to: [...to], amount: u64(data.subarray(4, 12)).toString() });
    }
    if (program && same(program, TOKEN_PROGRAM) && data.length === 10 && data[0] === 12) {
      const [mint, to] = [key(1), key(2)];
      if (mint && to) {
        payments.push({ asset: { Spl: { mint: [...mint] } }, to: [...to], amount: u64(data.subarray(1, 9)).toString() });
      }
    }
  }
  return payments;
}

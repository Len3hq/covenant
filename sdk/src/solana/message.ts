import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/** Programs and sysvars a vault message may name. The contract refuses any other program. */
export const SYSTEM_PROGRAM = new Uint8Array(32);
export const TOKEN_PROGRAM = base58.decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM = base58.decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const COMPUTE_BUDGET_PROGRAM = base58.decode("ComputeBudget111111111111111111111111111111");
export const RECENT_BLOCKHASHES_SYSVAR = base58.decode("SysvarRecentB1ockHashes11111111111111111111");
export const RENT_SYSVAR = base58.decode("SysvarRent111111111111111111111111111111111");
/** A nonce account's size, which sets the rent it must hold. */
export const NONCE_ACCOUNT_LEN = 80;

export interface AccountMeta {
  key: Uint8Array;
  signer: boolean;
  writable: boolean;
}

export interface Instruction {
  program: Uint8Array;
  accounts: AccountMeta[];
  data: Uint8Array;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

function u32(value: number): number[] {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return [...out];
}

function u64(value: bigint): number[] {
  if (value < 0n || value >= 1n << 64n) throw new Error(`${value} doesn't fit a u64`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return [...out];
}

/** Solana's `short_vec` length. */
export function shortVec(length: number): number[] {
  const out: number[] = [];
  let rest = length;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) return [...out, byte];
    out.push(byte | 0x80);
  }
}

const meta = (key: Uint8Array, writable: boolean, signer = false): AccountMeta => ({ key, signer, writable });

/** Must be the first instruction of every vault message: the contract refuses anything else. */
export const advanceNonce = (nonce: Uint8Array, authority: Uint8Array): Instruction => ({
  program: SYSTEM_PROGRAM,
  accounts: [meta(nonce, true), meta(RECENT_BLOCKHASHES_SYSVAR, false), meta(authority, false, true)],
  data: Uint8Array.from(u32(4)),
});

export const transfer = (from: Uint8Array, to: Uint8Array, lamports: bigint): Instruction => ({
  program: SYSTEM_PROGRAM,
  accounts: [meta(from, true, true), meta(to, true)],
  data: Uint8Array.from([...u32(2), ...u64(lamports)]),
});

export const transferChecked = (
  source: Uint8Array,
  mint: Uint8Array,
  destination: Uint8Array,
  owner: Uint8Array,
  amount: bigint,
  decimals: number,
): Instruction => ({
  program: TOKEN_PROGRAM,
  accounts: [meta(source, true), meta(mint, false), meta(destination, true), meta(owner, false, true)],
  data: Uint8Array.from([12, ...u64(amount), decimals]),
});

export const setComputeUnitLimit = (units: number): Instruction => ({
  program: COMPUTE_BUDGET_PROGRAM,
  accounts: [],
  data: Uint8Array.from([2, ...u32(units)]),
});

export const setComputeUnitPrice = (microLamports: bigint): Instruction => ({
  program: COMPUTE_BUDGET_PROGRAM,
  accounts: [],
  data: Uint8Array.from([3, ...u64(microLamports)]),
});

/** For setting up a nonce account, which a funder does, never the vault. */
export const createAccount = (
  from: Uint8Array,
  account: Uint8Array,
  lamports: bigint,
  space: number,
  owner: Uint8Array,
): Instruction => ({
  program: SYSTEM_PROGRAM,
  accounts: [meta(from, true, true), meta(account, true, true)],
  data: Uint8Array.from([...u32(0), ...u64(lamports), ...u64(BigInt(space)), ...owner]),
});

export const initializeNonce = (nonce: Uint8Array, authority: Uint8Array): Instruction => ({
  program: SYSTEM_PROGRAM,
  accounts: [meta(nonce, true), meta(RECENT_BLOCKHASHES_SYSVAR, false), meta(RENT_SYSVAR, false)],
  data: Uint8Array.from([...u32(6), ...authority]),
});

/**
 * A legacy message. Accounts are ordered as the runtime reads privileges: writable signers, then
 * read-only signers, writable others, and read-only others, with the fee payer first.
 */
export function compileMessage(feePayer: Uint8Array, blockhash: Uint8Array, instructions: Instruction[]): Uint8Array {
  const metas: AccountMeta[] = [meta(feePayer, true, true)];
  const add = (next: AccountMeta) => {
    const found = metas.find((known) => same(known.key, next.key));
    if (!found) {
      metas.push({ ...next });
      return;
    }
    found.signer ||= next.signer;
    found.writable ||= next.writable;
  };
  for (const instruction of instructions) {
    instruction.accounts.forEach(add);
    add(meta(instruction.program, false));
  }
  const rank = (account: AccountMeta) => (account.signer ? 0 : 2) + (account.writable ? 0 : 1);
  const [payer, ...rest] = metas;
  if (!payer) throw new Error("no fee payer");
  // Array.prototype.sort is stable, so accounts keep their first-seen order within each group.
  const ordered = [payer, ...rest.sort((a, b) => rank(a) - rank(b))];
  const index = (key: Uint8Array) => ordered.findIndex((account) => same(account.key, key));

  const signers = ordered.filter((account) => account.signer);
  const header = [
    signers.length,
    signers.filter((account) => !account.writable).length,
    ordered.filter((account) => !account.signer && !account.writable).length,
  ];
  const out: number[] = [...header, ...shortVec(ordered.length)];
  for (const account of ordered) out.push(...account.key);
  if (blockhash.length !== 32) throw new Error("a blockhash is 32 bytes");
  out.push(...blockhash, ...shortVec(instructions.length));
  for (const instruction of instructions) {
    out.push(index(instruction.program), ...shortVec(instruction.accounts.length));
    out.push(...instruction.accounts.map((account) => index(account.key)));
    out.push(...shortVec(instruction.data.length), ...instruction.data);
  }
  return Uint8Array.from(out);
}

/** A transaction with its signatures in signer order, as Solana's RPC accepts it. */
export const serializeTransaction = (signatures: Uint8Array[], message: Uint8Array): Uint8Array =>
  Uint8Array.from([...shortVec(signatures.length), ...signatures.flatMap((signature) => [...signature]), ...message]);

function onCurve(bytes: Uint8Array): boolean {
  try {
    // zip215 accepts every encoding the runtime's own decompression does.
    ed25519.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

/** A program-derived address: the first bump from 255 down whose hash has no private key. */
export function findProgramAddress(seeds: Uint8Array[], program: Uint8Array): Uint8Array {
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(Uint8Array.from([...seeds.flatMap((seed) => [...seed]), bump, ...program, ...marker]));
    if (!onCurve(hash)) return hash;
  }
  throw new Error("no program address found");
}

/** The wallet's associated token account for a classic SPL mint. */
export const associatedTokenAccount = (wallet: Uint8Array, mint: Uint8Array): Uint8Array =>
  findProgramAddress([wallet, TOKEN_PROGRAM, mint], ASSOCIATED_TOKEN_PROGRAM);

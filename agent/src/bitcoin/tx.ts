import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { Transaction } from "bitcoinjs-lib";

/** Opts in to replace-by-fee, so a stuck payment can be bumped. */
const RBF_SEQUENCE = 0xfffffffd;
/** The contract refuses smaller outputs. */
const MIN_OUTPUT_SATS = 546n;
/** The largest witness a P2WPKH input can carry, as the contract budgets it. */
const MAX_WITNESS_WEIGHT = 108;

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
}

export interface SpendRequest {
  /** Confirmed coins only. */
  utxos: Utxo[];
  maxInputs: number;
  to: Uint8Array;
  amount: bigint;
  /** The vault's own script. */
  change: Uint8Array;
  /** Whole sats per vbyte. */
  feeRate: bigint;
}

export interface Spend {
  tx: Transaction;
  inputs: Utxo[];
  fee: bigint;
}

export const hash160 = (bytes: Uint8Array) => ripemd160(sha256(bytes));

export function p2wpkhScript(pubkey: Uint8Array): Uint8Array {
  return Uint8Array.from([0x00, 0x14, ...hash160(pubkey)]);
}

/** The vsize the contract computes for the fee rate cap, before the witnesses exist. */
export function contractVsize(tx: Transaction): bigint {
  const weight = 4 * tx.toBuffer().length + 2 + MAX_WITNESS_WEIGHT * tx.ins.length;
  return BigInt(Math.ceil(weight / 4));
}

function assemble(inputs: Utxo[], to: Uint8Array, amount: bigint, change: Uint8Array, rest: bigint) {
  const tx = new Transaction();
  tx.version = 2;
  for (const input of inputs) {
    tx.addInput(hex.decode(input.txid).reverse(), input.vout, RBF_SEQUENCE);
  }
  tx.addOutput(to, amount);
  tx.addOutput(change, rest);
  return tx;
}

/** Selects the largest coins first, and sends what's left after the fee back to the vault. */
export function buildSpend(request: SpendRequest): Spend {
  const { to, amount, change, feeRate, maxInputs } = request;
  const largestFirst = [...request.utxos].sort((a, b) =>
    a.value === b.value ? 0 : a.value > b.value ? -1 : 1,
  );
  const inputs: Utxo[] = [];
  let total = 0n;
  for (const utxo of largestFirst.slice(0, maxInputs)) {
    inputs.push(utxo);
    total += utxo.value;
    const fee = feeRate * contractVsize(assemble(inputs, to, amount, change, 0n));
    const rest = total - amount - fee;
    if (rest >= MIN_OUTPUT_SATS) {
      return { tx: assemble(inputs, to, amount, change, rest), inputs, fee };
    }
  }
  throw new Error(`${maxInputs} inputs can't fund ${amount} sats plus the fee and change`);
}

/** The contract refuses a previous transaction with a witness, so it gets the bytes without one. */
export function stripWitness(rawHex: string, txid: string): Uint8Array {
  const tx = Transaction.fromHex(rawHex);
  if (tx.getId() !== txid) throw new Error(`previous transaction isn't ${txid}`);
  for (const input of tx.ins) input.witness = [];
  return tx.toBuffer();
}

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { hex } from "@scure/base";
import { payments, type Transaction } from "bitcoinjs-lib";
import { hash160 } from "./tx.js";

const SIGHASH_ALL = 1;
const ORDER = secp256k1.Point.Fn.ORDER;

export interface MpcSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
}

function derInteger(bytes: Uint8Array): number[] {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = [...bytes.slice(start)];
  const first = trimmed[0] ?? 0;
  return [0x02, ...(first & 0x80 ? [trimmed.length + 1, 0x00] : [trimmed.length]), ...trimmed];
}

export function derEncode(r: Uint8Array, s: Uint8Array): Uint8Array {
  const body = [...derInteger(r), ...derInteger(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** The MPC network can return a high `s`, which Bitcoin nodes refuse to relay. */
export function normalizeS(s: Uint8Array): Uint8Array {
  const value = bytesToNumberBE(s);
  return value > ORDER / 2n ? numberToBytesBE(ORDER - value, 32) : s;
}

/**
 * Fills in every witness. Each signature is checked against the vault's key and a sighash computed
 * here, independently of the contract, so a bad signature stops before anything is broadcast.
 */
export function attachWitnesses(
  tx: Transaction,
  signatures: MpcSignature[],
  pubkey: Uint8Array,
  amounts: bigint[],
): void {
  if (signatures.length !== tx.ins.length || amounts.length !== tx.ins.length) {
    throw new Error(`expected ${tx.ins.length} signatures, got ${signatures.length}`);
  }
  const scriptCode = payments.p2pkh({ hash: hash160(pubkey) }).output;
  if (!scriptCode) throw new Error("could not build the script code");

  const witnesses = signatures.map((signature, index) => {
    const r = hex.decode(signature.big_r.affine_point).slice(1);
    const s = normalizeS(hex.decode(signature.s.scalar));
    const sighash = tx.hashForWitnessV0(index, scriptCode, amounts[index] ?? 0n, SIGHASH_ALL);
    const compact = Uint8Array.from([...r, ...s]);
    const valid =
      compact.length === 64 &&
      secp256k1.verify(compact, sighash, pubkey, { prehash: false, format: "compact" });
    if (!valid) throw new Error(`signature for input ${index} doesn't verify against the vault key`);
    return [Uint8Array.from([...derEncode(r, s), SIGHASH_ALL]), pubkey];
  });
  witnesses.forEach((witness, index) => tx.setWitness(index, witness));
}

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, bech32, hex } from "@scure/base";

const NEAR_SECP_PREFIX = "secp256k1:";

/** Decodes a NEAR `secp256k1:<base58>` key, which is the 64-byte `x || y` point. */
export function parseNearSecp256k1(key: string): Uint8Array {
  if (!key.startsWith(NEAR_SECP_PREFIX)) throw new Error(`not a secp256k1 key: ${key}`);
  const point = base58.decode(key.slice(NEAR_SECP_PREFIX.length));
  if (point.length !== 64) throw new Error(`expected 64 bytes, got ${point.length}`);
  return point;
}

export function compressPubkey(point: Uint8Array): Uint8Array {
  const y = point[63];
  if (point.length !== 64 || y === undefined) throw new Error("expected a 64-byte point");
  const compressed = new Uint8Array(33);
  compressed[0] = y % 2 === 0 ? 0x02 : 0x03;
  compressed.set(point.slice(0, 32), 1);
  return compressed;
}

/** The P2WPKH address for a compressed key. `tb` covers testnet4, signet and testnet3. */
export function p2wpkhAddress(compressed: Uint8Array, hrp: "tb" | "bc" = "tb"): string {
  const program = ripemd160(sha256(compressed));
  return bech32.encode(hrp, [0, ...bech32.toWords(program)]);
}

/** Lowercase hex: `keccak256(x || y)`, last 20 bytes. */
export function evmAddress(point: Uint8Array): string {
  return `0x${hex.encode(keccak_256(point).slice(12))}`;
}

export interface MpcEcdsaSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
  scheme: string;
}

/**
 * Checks an MPC response against the key expected for its path. Recovery returns some key even
 * for a forged signature, so comparing with the derived key is what makes this a verification.
 */
export function verifyMpcSignature(
  signature: MpcEcdsaSignature,
  payload: Uint8Array,
  expectedCompressed: Uint8Array,
): boolean {
  const r = hex.decode(signature.big_r.affine_point).slice(1);
  const s = hex.decode(signature.s.scalar);
  const recovered = secp256k1.recoverPublicKey(
    Uint8Array.from([signature.recovery_id, ...r, ...s]),
    payload,
    { prehash: false },
  );
  return hex.encode(recovered) === hex.encode(expectedCompressed);
}

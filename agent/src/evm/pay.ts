import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  hexToBytes,
  isAddressEqual,
  keccak256,
  recoverAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import type { SpendOutcome, VaultClient } from "../vault.js";

const TRANSFER_GAS = 21_000n;
const ORDER = secp256k1.Point.Fn.ORDER;

export interface EvmChain {
  chainId: number;
  pendingNonce(address: Address): Promise<number>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Returns the transaction hash. */
  broadcast(serialized: Hex): Promise<Hex>;
}

export type EvmPayResult =
  | { status: "broadcast"; id: string; nearTx: string; hash: Hex }
  | { status: "not_signed"; outcome: SpendOutcome; nearTx: string };

export interface EvmSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

/**
 * Turns an MPC signature into viem's form and checks it recovers to the vault's address, so a bad
 * signature stops before broadcast. A high `s`, which EVM nodes refuse, is flipped along with its
 * recovery bit.
 */
export async function evmSignature(signature: EvmSignature, hash: Hex, expected: Address) {
  if (signature.recovery_id !== 0 && signature.recovery_id !== 1) {
    throw new Error(`unexpected recovery id ${signature.recovery_id}`);
  }
  const rawS = BigInt(`0x${signature.s.scalar}`);
  const flip = rawS > ORDER / 2n;
  const s = flip ? ORDER - rawS : rawS;
  const parsed = {
    r: `0x${signature.big_r.affine_point.slice(2)}` as Hex,
    s: `0x${s.toString(16).padStart(64, "0")}` as Hex,
    yParity: flip ? 1 - signature.recovery_id : signature.recovery_id,
  };
  const recovered = await recoverAddress({ hash, signature: parsed });
  if (!isAddressEqual(recovered, expected)) {
    throw new Error(`signature recovers to ${recovered}, not the vault's ${expected}`);
  }
  return parsed;
}

/** Builds a native transfer, has the contract sign it, and broadcasts only if the signature verifies. */
export async function payEth(
  deps: { vault: VaultClient; chain: EvmChain },
  to: Address,
  value: bigint,
): Promise<EvmPayResult> {
  const { vault, chain } = deps;
  const from = (await vault.evmAddress()) as Address;
  const fees = await chain.fees();
  const tx: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId: chain.chainId,
    nonce: await chain.pendingNonce(from),
    gas: TRANSFER_GAS,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    to,
    value,
    accessList: [],
  };
  const unsigned = serializeTransaction(tx);

  const { outcome, nearTx } = await vault.proposeEvm(hexToBytes(unsigned));
  if (!("Signed" in outcome)) return { status: "not_signed", outcome, nearTx };
  const [signature] = outcome.Signed.signatures;
  if (!signature || outcome.Signed.signatures.length !== 1) {
    throw new Error(`expected 1 signature, got ${outcome.Signed.signatures.length}`);
  }

  const parsed = await evmSignature(signature, keccak256(unsigned), from);
  const hash = await chain.broadcast(serializeTransaction(tx, parsed));
  return { status: "broadcast", id: outcome.Signed.id, nearTx, hash };
}

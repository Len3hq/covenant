import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  encodeFunctionData,
  erc20Abi,
  hexToBytes,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { ecdsa, type SpendOutcome, type VaultClient } from "../vault.js";

const TRANSFER_GAS = 21_000n;
/** A token transfer can cost more by the time it lands, and running out of gas wastes the fee. */
const GAS_MARGIN_PERCENT = 120n;
/** For a call the node can't estimate, such as one that would revert. The contract still checks it. */
const FALLBACK_CALL_GAS = 100_000n;
const ORDER = secp256k1.Point.Fn.ORDER;

export interface EvmChain {
  chainId: number;
  pendingNonce(address: Address): Promise<number>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Estimated gas for a call the vault would make. */
  estimateGas(call: { from: Address; to: Address; data: Hex }): Promise<bigint>;
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

/** Serializes an unsigned type-2 transaction from the vault, with today's fees and nonce. */
export async function prepareEvm(
  chain: EvmChain,
  from: Address,
  call: { to: Address; value: bigint; gas: bigint; data?: Hex },
): Promise<Hex> {
  const fees = await chain.fees();
  return serializeTransaction({
    type: "eip1559",
    chainId: chain.chainId,
    nonce: await chain.pendingNonce(from),
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    accessList: [],
    ...call,
  } satisfies TransactionSerializableEIP1559);
}

/** Adds the signature, checked against the vault's address, and returns what to broadcast. */
export async function signEvm(
  unsigned: Hex,
  signatures: EvmSignature[],
  from: Address,
): Promise<{ signedHex: Hex; chainTx: Hex }> {
  const [signature] = signatures;
  if (!signature || signatures.length !== 1) {
    throw new Error(`expected 1 signature, got ${signatures.length}`);
  }
  const parsed = await evmSignature(signature, keccak256(unsigned), from);
  const signedHex = serializeTransaction(
    parseTransaction(unsigned) as TransactionSerializableEIP1559,
    parsed,
  );
  return { signedHex, chainTx: keccak256(signedHex) };
}

/** Proposes a transaction, and broadcasts it only if the contract's signature verifies. */
async function signAndBroadcast(
  deps: { vault: VaultClient; chain: EvmChain },
  from: Address,
  call: { to: Address; value: bigint; gas: bigint; data?: Hex },
): Promise<EvmPayResult> {
  const { vault, chain } = deps;
  const unsigned = await prepareEvm(chain, from, call);
  const { outcome, nearTx } = await vault.proposeEvm(hexToBytes(unsigned));
  if (!("Signed" in outcome)) return { status: "not_signed", outcome, nearTx };
  const { signedHex } = await signEvm(unsigned, ecdsa(outcome.Signed.signatures), from);
  const hash = await chain.broadcast(signedHex);
  return { status: "broadcast", id: outcome.Signed.id, nearTx, hash };
}

/** A call to a contract, with an estimated gas limit. */
export async function contractCall(chain: EvmChain, from: Address, to: Address, data: Hex, value = 0n) {
  const estimate = await chain.estimateGas({ from, to, data }).catch(() => FALLBACK_CALL_GAS);
  return { to, value, gas: (estimate * GAS_MARGIN_PERCENT) / 100n, data };
}

/** The call data for an ERC-20 transfer. */
export const transferData = (to: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });

/** Pays native ETH from the vault. */
export async function payEth(
  deps: { vault: VaultClient; chain: EvmChain },
  to: Address,
  value: bigint,
): Promise<EvmPayResult> {
  const from = (await deps.vault.evmAddress()) as Address;
  return signAndBroadcast(deps, from, { to, value, gas: TRANSFER_GAS });
}

/** Pays an ERC-20 from the vault. `amount` is in the token's base units. */
export async function payToken(
  deps: { vault: VaultClient; chain: EvmChain },
  token: Address,
  to: Address,
  amount: bigint,
): Promise<EvmPayResult> {
  const from = (await deps.vault.evmAddress()) as Address;
  const call = await contractCall(deps.chain, from, token, transferData(to, amount));
  return signAndBroadcast(deps, from, call);
}

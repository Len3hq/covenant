import { hex } from "@scure/base";
import { address, networks, payments, Transaction } from "bitcoinjs-lib";
import type { Prepared } from "../store.js";
import type { SpendOutcome, VaultClient } from "../vault.js";
import type { Mempool } from "./mempool.js";
import { buildSpend, stripWitness } from "./tx.js";
import { attachWitnesses, type MpcSignature } from "./witness.js";

export type BitcoinPrepared = Extract<Prepared, { chain: "Bitcoin" }>;

export type PayResult =
  | { status: "broadcast"; id: string; nearTx: string; txid: string; fee: bigint }
  | { status: "not_signed"; outcome: SpendOutcome; nearTx: string };

export type PayDeps = {
  vault: VaultClient;
  mempool: Pick<Mempool, "spendableUtxos" | "txHex" | "feeRate" | "broadcast">;
};

/** Builds the unsigned spend, choosing coins and a fee rate within the contract's limits. */
export async function prepareBitcoin(
  deps: PayDeps,
  to: string,
  amount: bigint,
): Promise<{ prepared: BitcoinPrepared; fee: bigint }> {
  const { vault, mempool } = deps;
  const pubkey = await vault.btcPubkey();
  const own = payments.p2wpkh({ pubkey, network: networks.testnet });
  if (!own.address || !own.output) throw new Error("could not derive the vault address");

  const limits = await vault.btcLimits();
  const feeRate = await mempool.feeRate();
  const spend = buildSpend({
    utxos: await mempool.spendableUtxos(own.address),
    maxInputs: limits.maxInputs,
    to: address.toOutputScript(to, networks.testnet),
    amount,
    change: own.output,
    feeRate: feeRate < limits.maxFeeRate ? feeRate : limits.maxFeeRate,
  });
  const prevTxs = await Promise.all(
    spend.inputs.map(async ({ txid }) => stripWitness(await mempool.txHex(txid), txid)),
  );
  return {
    prepared: {
      chain: "Bitcoin",
      unsignedHex: hex.encode(spend.tx.toBuffer()),
      prevTxs: prevTxs.map((prev) => hex.encode(prev)),
      inputValues: spend.inputs.map((input) => input.value.toString()),
    },
    fee: spend.fee,
  };
}

/** Adds the signatures, each checked against the vault's key, and returns what to broadcast. */
export function signBitcoin(
  prepared: BitcoinPrepared,
  signatures: MpcSignature[],
  pubkey: Uint8Array,
): { signedHex: string; chainTx: string } {
  const tx = Transaction.fromHex(prepared.unsignedHex);
  attachWitnesses(tx, signatures, pubkey, prepared.inputValues.map(BigInt));
  return { signedHex: hex.encode(tx.toBuffer()), chainTx: tx.getId() };
}

/** Builds the spend, has the contract sign it, and broadcasts only if every signature verifies. */
export async function payBitcoin(deps: PayDeps, to: string, amount: bigint): Promise<PayResult> {
  const { vault, mempool } = deps;
  const { prepared, fee } = await prepareBitcoin(deps, to, amount);
  const { outcome, nearTx } = await vault.proposeBitcoin({
    tx: hex.decode(prepared.unsignedHex),
    prevTxs: prepared.prevTxs.map((prev) => hex.decode(prev)),
  });
  if (!("Signed" in outcome)) return { status: "not_signed", outcome, nearTx };

  const { signedHex } = signBitcoin(prepared, outcome.Signed.signatures, await vault.btcPubkey());
  const txid = await mempool.broadcast(signedHex);
  return { status: "broadcast", id: outcome.Signed.id, nearTx, txid, fee };
}

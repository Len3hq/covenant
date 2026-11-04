import { hex } from "@scure/base";
import { address, networks, payments } from "bitcoinjs-lib";
import type { SpendOutcome, VaultClient } from "../vault.js";
import type { Mempool } from "./mempool.js";
import { buildSpend, stripWitness } from "./tx.js";
import { attachWitnesses } from "./witness.js";

export type PayResult =
  | { status: "broadcast"; id: string; nearTx: string; txid: string; fee: bigint }
  | { status: "not_signed"; outcome: SpendOutcome; nearTx: string };

export type PayDeps = {
  vault: VaultClient;
  mempool: Pick<Mempool, "confirmedUtxos" | "txHex" | "feeRate" | "broadcast">;
};

/** Builds the spend, has the contract sign it, and broadcasts only if every signature verifies. */
export async function payBitcoin(deps: PayDeps, to: string, amount: bigint): Promise<PayResult> {
  const { vault, mempool } = deps;
  const pubkey = await vault.btcPubkey();
  const own = payments.p2wpkh({ pubkey, network: networks.testnet });
  if (!own.address || !own.output) throw new Error("could not derive the vault address");

  const limits = await vault.btcLimits();
  const feeRate = await mempool.feeRate();
  const spend = buildSpend({
    utxos: await mempool.confirmedUtxos(own.address),
    maxInputs: limits.maxInputs,
    to: address.toOutputScript(to, networks.testnet),
    amount,
    change: own.output,
    feeRate: feeRate < limits.maxFeeRate ? feeRate : limits.maxFeeRate,
  });
  const prevTxs = await Promise.all(
    spend.inputs.map(async ({ txid }) => stripWitness(await mempool.txHex(txid), txid)),
  );

  const { outcome, nearTx } = await vault.proposeBitcoin({ tx: spend.tx.toBuffer(), prevTxs });
  if (!("Signed" in outcome)) return { status: "not_signed", outcome, nearTx };

  attachWitnesses(
    spend.tx,
    outcome.Signed.signatures,
    pubkey,
    spend.inputs.map((input) => input.value),
  );
  const txid = await mempool.broadcast(hex.encode(spend.tx.toBuffer()));
  return { status: "broadcast", id: outcome.Signed.id, nearTx, txid, fee: spend.fee };
}

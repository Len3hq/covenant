import { hex } from "@scure/base";
import { address, networks } from "bitcoinjs-lib";
import { getAddress, parseTransaction, type Address, type Hex } from "viem";
import { prepareBitcoin, type PayDeps } from "./bitcoin/pay.js";
import { contractCall, prepareEvm, transferData, type EvmChain } from "./evm/pay.js";
import { prepareSolana, type SolanaDeps } from "./solana/pay.js";
import { base58 } from "@scure/base";
import type { Prepared } from "./store.js";
import type { AgentVault, PolicyPayee } from "./vault.js";

const TRANSFER_GAS = 21_000n;

/**
 * What a payment moves. Amounts are always whole base units: sats, wei, lamports, or USDC's 6
 * decimals. `USDC` is on Base; `USDC-SOL` is on Solana.
 */
export type Asset = "BTC" | "ETH" | "USDC" | "SOL" | "USDC-SOL";

export const ASSETS = ["BTC", "ETH", "USDC", "SOL", "USDC-SOL"] as const satisfies readonly Asset[];

const CHAIN_OF: Record<Asset, PolicyPayee["chain"]> = {
  BTC: "Bitcoin",
  ETH: "Evm",
  USDC: "Evm",
  SOL: "Solana",
  "USDC-SOL": "Solana",
};

/** A payee's address as its chain writes it. */
export function payeeAddress(payee: PolicyPayee): string {
  const bytes = Uint8Array.from(payee.to);
  if (payee.chain === "Solana") return base58.encode(bytes);
  return payee.chain === "Bitcoin"
    ? address.fromOutputScript(bytes, networks.testnet)
    : getAddress(`0x${hex.encode(bytes)}`);
}

/** A payee's label becomes its address. Anything else is taken as an address, for the vault to judge. */
export async function resolvePayee(vault: AgentVault, to: string, asset: Asset): Promise<string> {
  const listed = (await vault.payees()).find(
    (payee) => payee.chain === CHAIN_OF[asset] && payee.label.toLowerCase() === to.trim().toLowerCase(),
  );
  return listed ? payeeAddress(listed) : to.trim();
}

export interface PrepareDeps {
  vault: AgentVault;
  bitcoin: PayDeps;
  chain: EvmChain;
  usdc: Address;
  solana?: SolanaDeps;
  /** Coins an unfinished spend holds, as `txid:vout`, which this payment must not use. */
  heldCoins?: () => Set<string>;
  /** Unfinished Base spends. While one is unfinished, another Base payment is refused. */
  unfinishedEvm?: () => UnfinishedEvm[];
}

export interface UnfinishedEvm {
  id?: string;
  status: string;
  description: string;
  prepared: { unsignedHex: string };
}

/**
 * Refuses a Base payment while another is unfinished: both would get the same nonce, and the one
 * signed second would be charged to the budget but could never land. A spend whose nonce the chain
 * has passed has landed or never can, and a queued spend that has left the vault's queue was
 * vetoed, so neither counts.
 */
async function checkNoEvmInFlight(deps: PrepareDeps, from: Address): Promise<void> {
  const unfinished = deps.unfinishedEvm?.() ?? [];
  if (unfinished.length === 0) return;
  const [next, queue] = await Promise.all([deps.chain.pendingNonce(from), deps.vault.queue()]);
  const queued = new Set(queue.map(({ id }) => id));
  const blocking = unfinished.find(({ id, status, prepared }) => {
    const nonce = parseTransaction(prepared.unsignedHex as Hex).nonce ?? 0;
    if (nonce < next) return false;
    return status !== "queued" || (id !== undefined && queued.has(id));
  });
  if (!blocking) return;
  const which = blocking.id ? `spend ${blocking.id}` : "a payment";
  throw new Error(
    `Another Base payment (${which}: ${blocking.description}) is still ${blocking.status}. ` +
      "Execute or veto it first: two Base payments at once would share a nonce, and the second couldn't land.",
  );
}

async function evmPrepared(
  deps: PrepareDeps,
  call: { to: Address; value: bigint; gas: bigint; data?: Hex },
): Promise<Prepared> {
  const from = (await deps.vault.evmAddress()) as Address;
  await checkNoEvmInFlight(deps, from);
  return { chain: "Evm", unsignedHex: await prepareEvm(deps.chain, from, call) };
}

/** Builds the unsigned transaction for a payment, ready to propose. */
export async function preparePayment(
  deps: PrepareDeps,
  asset: Asset,
  destination: string,
  amount: bigint,
): Promise<Prepared> {
  if (asset === "SOL" || asset === "USDC-SOL") {
    if (!deps.solana) throw new Error("this client isn't set up for Solana");
    return prepareSolana(deps.solana, asset, destination, amount);
  }
  if (asset === "BTC") {
    const held = deps.heldCoins?.() ?? new Set<string>();
    const { mempool } = deps.bitcoin;
    // Each method is bound, not spread: spreading a class instance drops its methods.
    const free: PayDeps = {
      ...deps.bitcoin,
      mempool: {
        spendableUtxos: async (owner) =>
          (await mempool.spendableUtxos(owner)).filter((coin) => !held.has(`${coin.txid}:${coin.vout}`)),
        txHex: (txid) => mempool.txHex(txid),
        feeRate: () => mempool.feeRate(),
        broadcast: (signedHex) => mempool.broadcast(signedHex),
      },
    };
    return (await prepareBitcoin(free, destination, amount)).prepared;
  }
  const payee = getAddress(destination);
  if (asset === "ETH") return evmPrepared(deps, { to: payee, value: amount, gas: TRANSFER_GAS });
  const from = (await deps.vault.evmAddress()) as Address;
  return evmPrepared(deps, await contractCall(deps.chain, from, deps.usdc, transferData(payee, amount)));
}

/** Builds an arbitrary EVM call from the vault. The vault refuses anything but plain transfers. */
export async function prepareCall(deps: PrepareDeps, target: Address, data: Hex, value: bigint): Promise<Prepared> {
  const from = (await deps.vault.evmAddress()) as Address;
  return evmPrepared(deps, await contractCall(deps.chain, from, target, data, value));
}

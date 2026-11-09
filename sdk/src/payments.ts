import { hex } from "@scure/base";
import { address, networks } from "bitcoinjs-lib";
import { getAddress, type Address, type Hex } from "viem";
import { prepareBitcoin, type PayDeps } from "./bitcoin/pay.js";
import { contractCall, prepareEvm, transferData, type EvmChain } from "./evm/pay.js";
import type { Prepared } from "./store.js";
import type { AgentVault, PolicyPayee } from "./vault.js";

const TRANSFER_GAS = 21_000n;

/** What a payment moves. Amounts are always whole base units: sats, wei, or USDC's 6 decimals. */
export type Asset = "BTC" | "ETH" | "USDC";

const CHAIN_OF: Record<Asset, PolicyPayee["chain"]> = { BTC: "Bitcoin", ETH: "Evm", USDC: "Evm" };

/** A payee's address as its chain writes it. */
export function payeeAddress(payee: PolicyPayee): string {
  const bytes = Uint8Array.from(payee.to);
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
  /** Coins an unfinished spend holds, as `txid:vout`, which this payment must not use. */
  heldCoins?: () => Set<string>;
}

async function evmPrepared(
  deps: PrepareDeps,
  call: { to: Address; value: bigint; gas: bigint; data?: Hex },
): Promise<Prepared> {
  const from = (await deps.vault.evmAddress()) as Address;
  return { chain: "Evm", unsignedHex: await prepareEvm(deps.chain, from, call) };
}

/** Builds the unsigned transaction for a payment, ready to propose. */
export async function preparePayment(
  deps: PrepareDeps,
  asset: Asset,
  destination: string,
  amount: bigint,
): Promise<Prepared> {
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

import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { address, networks } from "bitcoinjs-lib";
import { getAddress, hexToBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import { prepareBitcoin, type PayDeps } from "./bitcoin/pay.js";
import { contractCall, prepareEvm, transferData, type EvmChain } from "./evm/pay.js";
import type { ToolSpec } from "./llm/index.js";
import type { Payer, SpendReport } from "./payer.js";
import type { Prepared } from "./store.js";
import type { AgentVault, PolicyPayee } from "./vault.js";

const TRANSFER_GAS = 21_000n;
/** Integers only: sats, wei and token base units. */
const baseUnits = z.string().regex(/^\d+$/, "a whole number of base units");

export interface ChainReads {
  btcBalance(): Promise<bigint>;
  ethBalance(): Promise<bigint>;
  tokenBalance(): Promise<bigint>;
}

export interface ToolDeps {
  vault: AgentVault;
  payer: Payer;
  reads: ChainReads;
  bitcoin: PayDeps;
  chain: EvmChain;
  usdc: Address;
  /** Scopes a spend's identity, so one run's retry is the same spend and a new run's isn't. */
  runId: string;
  /** Every spend the tools made, for the caller to check and print. */
  onSpend?: (asset: string, to: string, report: SpendReport) => void;
}

export interface Tool {
  spec: ToolSpec;
  run(input: unknown): Promise<unknown>;
}

function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<unknown>,
): Tool {
  return {
    spec: { name, description, parameters: z.toJSONSchema(schema) as Record<string, unknown> },
    run: async (input) => run(schema.parse(input)),
  };
}

function payeeAddress(payee: PolicyPayee): string {
  const bytes = Uint8Array.from(payee.to);
  return payee.chain === "Bitcoin"
    ? address.fromOutputScript(bytes, networks.testnet)
    : getAddress(`0x${hex.encode(bytes)}`);
}

export const spendKey = (...parts: string[]) => hex.encode(sha256(new TextEncoder().encode(parts.join("|"))));

const assets = { BTC: "Bitcoin", ETH: "Evm", USDC: "Evm" } as const;

export function createTools(deps: ToolDeps): Tool[] {
  const { vault, payer, reads, chain, usdc, runId } = deps;

  const resolve = async (to: string, asset: keyof typeof assets): Promise<string> => {
    const payees = await vault.payees();
    const listed = payees.find(
      (payee) =>
        payee.chain === assets[asset] && payee.label.toLowerCase() === to.trim().toLowerCase(),
    );
    return listed ? payeeAddress(listed) : to.trim();
  };

  const evmPrepared = async (call: {
    to: Address;
    value: bigint;
    gas: bigint;
    data?: Hex;
  }): Promise<Prepared> => {
    const from = (await vault.evmAddress()) as Address;
    return { chain: "Evm", unsignedHex: await prepareEvm(chain, from, call) };
  };

  return [
    tool("get_balances", "The vault's balances, and what it has spent in the last 24 hours.", z.object({}), async () => {
      const [btc, eth, token, btcSpent, ethSpent, usdcSpent] = await Promise.all([
        reads.btcBalance(),
        reads.ethBalance(),
        reads.tokenBalance(),
        vault.spent24h("Btc"),
        vault.spent24h({ EvmNative: { chain_id: chain.chainId } }),
        vault.spent24h({ Erc20: { chain_id: chain.chainId, token: [...hexToBytes(usdc)] } }),
      ]);
      return {
        BTC: { unit: "sats", balance: btc.toString(), spent24h: btcSpent },
        ETH: { unit: "wei", balance: eth.toString(), spent24h: ethSpent },
        USDC: { unit: "base units; 1 USDC is 1000000", balance: token.toString(), spent24h: usdcSpent },
      };
    }),
    tool("list_payees", "The payees the vault knows, with their labels and addresses.", z.object({}), async () => {
      const payees = await vault.payees();
      return payees.map((payee) => ({
        label: payee.label,
        chain: payee.chain,
        address: payeeAddress(payee),
      }));
    }),
    tool(
      "pay",
      "Pays from the vault, to a payee's label or to any address. `amount` is a whole number of base units: sats for BTC, wei for ETH, and for USDC 1000000 is 1 USDC. Reports signed, queued or rejected.",
      z.object({
        to: z.string(),
        asset: z.enum(["BTC", "ETH", "USDC"]),
        amount: baseUnits,
        memo: z.string(),
      }),
      async ({ to, asset, amount, memo }) => {
        const value = BigInt(amount);
        const destination = await resolve(to, asset);
        const key = spendKey(runId, "pay", asset, destination, amount, memo);
        const description = `${amount} ${asset} to ${destination}: ${memo}`;
        const result = await payer.spend(key, description, async () => {
          if (asset === "BTC") {
            return (await prepareBitcoin(deps.bitcoin, destination, value)).prepared;
          }
          const payee = getAddress(destination);
          if (asset === "ETH") return evmPrepared({ to: payee, value, gas: TRANSFER_GAS });
          const from = (await vault.evmAddress()) as Address;
          return evmPrepared(await contractCall(chain, from, usdc, transferData(payee, value)));
        });
        deps.onSpend?.(asset, destination, result);
        return result;
      },
    ),
    tool(
      "evm_call",
      "Makes any call from the vault's EVM address. `data` is hex call data, and `value` is in wei.",
      z.object({
        to: z.string(),
        data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "hex call data"),
        value: baseUnits,
      }),
      async ({ to, data, value }) => {
        const target = getAddress(to);
        const key = spendKey(runId, "evm_call", target, data, value);
        const result = await payer.spend(key, `call ${target} with ${data}`, async () => {
          const from = (await vault.evmAddress()) as Address;
          return evmPrepared(await contractCall(chain, from, target, data as Hex, BigInt(value)));
        });
        deps.onSpend?.("EVM call", target, result);
        return result;
      },
    ),
    tool("spend_status", "Whether a spend is still in the veto queue, and when it can execute.", z.object({ id: z.string() }), async ({ id }) => {
      const queued = (await vault.queue()).find((spend) => spend.id === id);
      return queued
        ? { queued: true, executableAt: queued.executable_at }
        : { queued: false, note: "It has executed or been vetoed, or never queued." };
    }),
    tool("execute_queued", "Signs and broadcasts a queued spend whose veto window has passed.", z.object({ id: z.string() }), async ({ id }) => {
      const result = await payer.execute(id);
      deps.onSpend?.("queued spend", `spend ${id}`, result);
      return result;
    }),
  ];
}

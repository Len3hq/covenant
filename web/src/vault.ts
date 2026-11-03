import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, hex } from "@scure/base";

export interface VaultConfig {
  rpcUrl: string;
  accountId: string;
}

export const defaultConfig: VaultConfig = {
  rpcUrl: import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
  accountId: import.meta.env.VITE_VAULT_ACCOUNT_ID ?? "covenant.len3hq.testnet",
};

export type Asset =
  | "Btc"
  | "Sol"
  | { EvmNative: { chain_id: number } }
  | { Erc20: { chain_id: number; token: number[] } }
  | { Spl: { mint: number[] } };

export interface AssetCap {
  asset: Asset;
  per_tx: string;
  per_24h: string;
  queue_at: string;
}

export interface Payee {
  chain: "Bitcoin" | "Evm" | "Solana";
  to: number[];
  label: string;
}

export interface Policy {
  caps: AssetCap[];
  payees: Payee[];
  btc_max_fee_rate: number;
  btc_max_inputs: number;
  evm_chain_ids: number[];
  evm_max_gas_cost: string;
  veto_delay_ns: number;
}

export interface VaultState {
  frozen: boolean;
  btcAddress: string;
  evmAddress: string;
  policy: Policy;
}

interface Addresses {
  btc_pubkey: string;
  evm_address: string;
}

async function view<T>(config: VaultConfig, method: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: method,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: config.accountId,
        method_name: method,
        args_base64: btoa("{}"),
      },
    }),
  });
  if (!response.ok) throw new Error(`${method}: RPC returned ${response.status}`);
  const body = (await response.json()) as {
    result?: { result?: number[]; error?: string };
    error?: { message?: string };
  };
  const bytes = body.result?.result;
  if (!bytes) {
    throw new Error(`${method}: ${body.result?.error ?? body.error?.message ?? "no result"}`);
  }
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as T;
}

/** The testnet4 P2WPKH address for the vault's compressed key. */
export function btcAddress(pubkeyHex: string): string {
  const program = ripemd160(sha256(hex.decode(pubkeyHex)));
  return bech32.encode("tb", [0, ...bech32.toWords(program)]);
}

export async function loadVault(
  config: VaultConfig = defaultConfig,
  fetcher: typeof fetch = fetch,
): Promise<VaultState> {
  const [frozen, addresses, policy] = await Promise.all([
    view<boolean>(config, "is_frozen", fetcher),
    view<Addresses>(config, "get_addresses", fetcher),
    view<Policy>(config, "get_policy", fetcher),
  ]);
  return {
    frozen,
    btcAddress: btcAddress(addresses.btc_pubkey),
    evmAddress: addresses.evm_address,
    policy,
  };
}

function bytesToHex(bytes: number[]): string {
  return hex.encode(Uint8Array.from(bytes));
}

/** Names an asset and the integer unit its caps are in. */
export function describeAsset(asset: Asset): { name: string; unit: string } {
  if (asset === "Btc") return { name: "BTC", unit: "sats" };
  if (asset === "Sol") return { name: "SOL", unit: "lamports" };
  if ("EvmNative" in asset) {
    return { name: `ETH (chain ${asset.EvmNative.chain_id})`, unit: "wei" };
  }
  if ("Erc20" in asset) {
    const { chain_id, token } = asset.Erc20;
    return { name: `ERC-20 0x${bytesToHex(token)} (chain ${chain_id})`, unit: "base units" };
  }
  return { name: `SPL ${bytesToHex(asset.Spl.mint)}`, unit: "base units" };
}

export function describePayee(payee: Payee): string {
  const prefix = payee.chain === "Evm" ? "0x" : "";
  return `${payee.label} (${payee.chain}): ${prefix}${bytesToHex(payee.to)}`;
}

/** Whole seconds, since the delay is only ever shown to a person. */
export function vetoDelaySeconds(policy: Policy): number {
  return Math.floor(policy.veto_delay_ns / 1_000_000_000);
}

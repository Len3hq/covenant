import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, hex } from "@scure/base";

export interface VaultConfig {
  rpcUrl: string;
  accountId: string;
  btcApiUrl: string;
  evmRpcUrl: string;
  evmChainId: number;
}

const USDC_BASE_SEPOLIA = "036cbd53842c5426634e7929541ec2318f3dcf7e";
const BALANCE_OF = "70a08231";

export const defaultConfig: VaultConfig = {
  rpcUrl: import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
  accountId: import.meta.env.VITE_VAULT_ACCOUNT_ID ?? "covenant.len3hq.testnet",
  btcApiUrl: import.meta.env.VITE_BTC_API_URL ?? "https://mempool.space/testnet4/api",
  evmRpcUrl: import.meta.env.VITE_EVM_RPC_URL ?? "https://sepolia.base.org",
  evmChainId: 84532,
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

/** Amounts are integer strings in the asset's base unit. */
export interface Balance {
  name: string;
  unit: string;
  /** Null when the chain couldn't be read. */
  balance: string | null;
  spent24h: string;
  per24h: string;
}

export interface VaultState {
  frozen: boolean;
  btcAddress: string;
  evmAddress: string;
  policy: Policy;
  balances: Balance[];
}

interface Addresses {
  btc_pubkey: string;
  evm_address: string;
}

async function view<T>(
  config: VaultConfig,
  method: string,
  fetcher: typeof fetch,
  args: unknown = {},
): Promise<T> {
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
        args_base64: btoa(JSON.stringify(args)),
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

async function btcBalance(config: VaultConfig, address: string, fetcher: typeof fetch) {
  const response = await fetcher(`${config.btcApiUrl}/address/${address}`);
  if (!response.ok) throw new Error(`BTC API returned ${response.status}`);
  interface Stats {
    funded_txo_sum: number;
    spent_txo_sum: number;
  }
  const { chain_stats: chain, mempool_stats: mempool } = (await response.json()) as {
    chain_stats: Stats;
    mempool_stats: Stats;
  };
  const funded = BigInt(chain.funded_txo_sum) + BigInt(mempool.funded_txo_sum);
  return funded - BigInt(chain.spent_txo_sum) - BigInt(mempool.spent_txo_sum);
}

async function evmRead(
  config: VaultConfig,
  method: string,
  params: unknown[],
  fetcher: typeof fetch,
): Promise<bigint> {
  const response = await fetcher(config.evmRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) throw new Error(`EVM RPC returned ${response.status}`);
  const { result } = (await response.json()) as { result?: string };
  if (!result) throw new Error(`${method}: no result`);
  return BigInt(result);
}

function chainBalance(
  config: VaultConfig,
  asset: Asset,
  addresses: { btc: string; evm: string },
  fetcher: typeof fetch,
): Promise<bigint> | null {
  if (asset === "Btc") return btcBalance(config, addresses.btc, fetcher);
  if (asset === "Sol" || "Spl" in asset) return null;
  if ("EvmNative" in asset) {
    if (asset.EvmNative.chain_id !== config.evmChainId) return null;
    return evmRead(config, "eth_getBalance", [addresses.evm, "latest"], fetcher);
  }
  if (asset.Erc20.chain_id !== config.evmChainId) return null;
  const data = `0x${BALANCE_OF}${addresses.evm.slice(2).padStart(64, "0")}`;
  const call = { to: `0x${bytesToHex(asset.Erc20.token)}`, data };
  return evmRead(config, "eth_call", [call, "latest"], fetcher);
}

/** A chain that can't be read costs one row its balance, not the whole dashboard. */
async function loadBalance(
  config: VaultConfig,
  cap: AssetCap,
  addresses: { btc: string; evm: string },
  fetcher: typeof fetch,
): Promise<Balance> {
  const [spent24h, balance] = await Promise.all([
    view<string>(config, "get_spent_24h", fetcher, { asset: cap.asset }),
    Promise.resolve(chainBalance(config, cap.asset, addresses, fetcher)).catch(() => null),
  ]);
  return {
    ...describeAsset(cap.asset),
    balance: balance === null ? null : balance.toString(),
    spent24h,
    per24h: cap.per_24h,
  };
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
  const btc = btcAddress(addresses.btc_pubkey);
  const balances = await Promise.all(
    policy.caps.map((cap) =>
      loadBalance(config, cap, { btc, evm: addresses.evm_address }, fetcher),
    ),
  );
  return { frozen, btcAddress: btc, evmAddress: addresses.evm_address, policy, balances };
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
    if (bytesToHex(token) === USDC_BASE_SEPOLIA) return { name: "USDC", unit: "base units" };
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

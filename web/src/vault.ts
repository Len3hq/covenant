import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, bech32, hex } from "@scure/base";
import { requestedPayments } from "./decode";
import { associatedTokenAccount, SOL_USDC_DEVNET } from "./solana";

export interface VaultConfig {
  rpcUrl: string;
  accountId: string;
  btcApiUrl: string;
  evmRpcUrl: string;
  evmChainId: number;
  txApiUrl: string;
  solRpcUrl: string;
}

const USDC_BASE_SEPOLIA = "036cbd53842c5426634e7929541ec2318f3dcf7e";
const BALANCE_OF = "70a08231";

export const defaultConfig: VaultConfig = {
  rpcUrl: import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com",
  accountId: import.meta.env.VITE_VAULT_ACCOUNT_ID ?? "covenant.len3hq.testnet",
  btcApiUrl: import.meta.env.VITE_BTC_API_URL ?? "https://mempool.space/testnet4/api",
  evmRpcUrl: import.meta.env.VITE_EVM_RPC_URL ?? "https://sepolia.base.org",
  evmChainId: 84532,
  txApiUrl: import.meta.env.VITE_NEAR_TX_API_URL ?? "https://tx.test.fastnear.com",
  solRpcUrl: import.meta.env.VITE_SOL_RPC_URL ?? "https://api.devnet.solana.com",
};

const SOL_USDC_DEVNET_HEX = hex.encode(base58.decode(SOL_USDC_DEVNET));

/** Creates vaults that nobody, including us, can change. */
export const FACTORY_ID: string = import.meta.env.VITE_FACTORY_ACCOUNT_ID ?? "vaults.len3hq.testnet";

/** The vault named in the page's URL, so one hosted dashboard can show any of them. */
export function vaultFromUrl(search: string, fallback: string): string {
  return new URLSearchParams(search).get("vault")?.trim().toLowerCase() || fallback;
}

/** Public testnet RPCs that allow browser requests, tried in order when the one in use fails. */
export const RPC_FALLBACKS = ["https://near-testnet.drpc.org", "https://rpc.testnet.near.org"];

/**
 * A fetch that moves to the next RPC when one is down or rate-limits, and stays on the one that
 * answered. Public RPCs throttle by IP, and the page polls every few seconds.
 */
export function withRpcFallback(
  primary: string,
  fallbacks: string[] = RPC_FALLBACKS,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  const urls = [primary, ...fallbacks.filter((url) => url !== primary)];
  let current = 0;
  return async (input, init) => {
    if (input !== primary) return fetcher(input, init);
    let last: unknown = new Error("no RPC answered");
    for (let tried = 0; tried < urls.length; tried++) {
      const index = (current + tried) % urls.length;
      try {
        const response = await fetcher(urls[index] as string, init);
        if (response.status !== 429 && response.status < 500) {
          current = index;
          return response;
        }
        last = new Error(`RPC returned ${response.status}`);
      } catch (error) {
        last = error;
      }
    }
    throw last;
  };
}

/** An outside service that hangs costs its own row, not the whole dashboard. */
const OUTSIDE_TIMEOUT_MS = 5_000;

/** Transactions read per refresh. The API takes up to this many hashes at once. */
const ACTIVITY_LIMIT = 20;

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
  /** What unlisted payees may receive per 24 hours. Absent on older vaults, which refuse them. */
  unlisted_per_24h?: string;
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
  /** Lamports. Absent on vaults from before Solana support, which refuse Solana. */
  sol_max_fee?: string;
  /** Absent on vaults from before open payees, which refuse unlisted payees. */
  unlisted?: "Refuse" | "Hold";
  unlisted_veto_delay_ns?: number;
  /** Absent or null: swaps are refused. */
  swap?: {
    maker_key: number[];
    origins: { asset_id: string; asset: Asset }[];
    destinations: string[];
    payees: { destination_asset: string; recipient: string; label: string }[];
    max_slippage_bps: number;
    min_deposit_window_ns: number;
  } | null;
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

export interface Payment {
  asset: Asset;
  to: number[];
  amount: string;
}

export interface Pending {
  id: string;
  chain: Payee["chain"];
  payments: Payment[];
  fee: string;
  queued_at: string;
  executable_at: string;
}

/** What a swap's signed quote committed to, as the vault logs it. */
export interface SwapInfo {
  correlation_id: string;
  deposit_address: string;
  destination_asset: string;
  recipient: string;
  min_amount_out: string;
  deadline_ns: string;
}

/** A Tidepool asset id in words, such as "USDC on Base" for its Base USDC. */
export function swapAssetName(assetId: string): string {
  const match = /^nep141:([a-z]+)(?:-(0x[0-9a-f]+|[0-9a-f]+))?\.tp-omft\.testnet$/.exec(assetId);
  const chains: Record<string, string> = {
    btc: "Bitcoin",
    base: "Base",
    arb: "Arbitrum",
    eth: "Ethereum",
    bsc: "BSC",
    sol: "Solana",
    stellar: "Stellar",
    sui: "Sui",
    xrp: "XRP Ledger",
  };
  const chain = match?.[1] ? chains[match[1]] : undefined;
  if (!chain) return assetId;
  return match?.[2] ? `a token on ${chain} (${assetId})` : `the native coin on ${chain}`;
}

/** One line for the log, such as "Swapped to at least 97020000 base units of …, for 4zMM…". */
export const describeSwap = (swap: SwapInfo) =>
  `Swapped through Tidepool: at least ${swap.min_amount_out} base units of ${swapAssetName(swap.destination_asset)}, for ${swap.recipient}`;

export interface Activity {
  event: string;
  id?: string;
  chain?: Payee["chain"];
  payments: Payment[];
  fee?: string;
  error?: string;
  by?: string;
  txHash: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** Present when the spend paid a swap's deposit address. */
  swap?: SwapInfo;
  /**
   * What the agent asked to pay, decoded by the dashboard from its request, for display only. Set on
   * a refusal whose event carries no payments, because the contract refused while parsing.
   */
  requested?: Payment[];
}

export interface Roles {
  owner: string;
  guardian: string | null;
  agent: string;
}

/** Set when the guardian is a Sputnik DAO, whose council votes on the guardian's actions. */
export interface GuardianDao {
  accountId: string;
  council: string[];
  proposalBond: string;
  nextProposalId: number;
}

export interface VaultState {
  roles: Roles;
  guardianDao: GuardianDao | null;
  frozen: boolean;
  btcAddress: string;
  evmAddress: string;
  /** Absent on vaults from before Solana support. */
  solAddress?: string;
  policy: Policy;
  balances: Balance[];
  queue: Pending[];
  /** Null when the transaction API couldn't be read. */
  activity: Activity[] | null;
  /** The vault account's NEAR, in yoctoNEAR. It pays for storage and the `sign` deposits. */
  nearBalance: string | null;
  /** The smallest allowance left on the agent's function-call keys, in yoctoNEAR. */
  agentAllowance: string | null;
}

const YOCTO = 10n ** 24n;
/** Below this the vault may not cover its storage as the queue grows. */
const LOW_VAULT_NEAR = YOCTO;
/** A 300 Tgas call needs about 0.3 NEAR of allowance left to pass the pessimistic gas check. */
const LOW_ALLOWANCE = (YOCTO * 4n) / 10n;
const LOW_BALANCE_SHARE = 10n;

/** What needs topping up, in plain words. Empty when nothing does. */
export function warnings(vault: VaultState): string[] {
  const found: string[] = [];
  if (vault.nearBalance !== null && BigInt(vault.nearBalance) < LOW_VAULT_NEAR) {
    found.push(`The vault has ${formatNear(vault.nearBalance)} NEAR left; keep it above 1 NEAR.`);
  }
  if (vault.agentAllowance !== null && BigInt(vault.agentAllowance) < LOW_ALLOWANCE) {
    found.push(
      `The agent's key has ${formatNear(vault.agentAllowance)} NEAR of allowance left. Below about 0.3 it can't send a spend, so replace the key.`,
    );
  }
  for (const cap of vault.policy.caps) {
    const { name, unit } = describeAsset(cap.asset);
    const row = vault.balances.find((balance) => balance.name === name);
    // A tenth of the largest payment the policy allows: low enough that live runs will soon fail.
    if (row?.balance != null && BigInt(row.balance) * LOW_BALANCE_SHARE < BigInt(cap.per_tx)) {
      found.push(`${name} is low: ${row.balance} ${unit}, under a tenth of the ${cap.per_tx} ${unit} payment cap.`);
    }
  }
  return found;
}

/** NEAR to two decimal places, from yoctoNEAR. */
export function formatNear(yocto: string): string {
  const hundredths = BigInt(yocto) / (YOCTO / 100n);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

interface Addresses {
  btc_pubkey: string;
  evm_address: string;
  sol_address?: string;
}

interface ChainAddresses {
  btc: string;
  evm: string;
  sol?: string;
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
  const response = await fetcher(`${config.btcApiUrl}/address/${address}`, {
    signal: AbortSignal.timeout(OUTSIDE_TIMEOUT_MS),
  });
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
    signal: AbortSignal.timeout(OUTSIDE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`EVM RPC returned ${response.status}`);
  const { result } = (await response.json()) as { result?: string };
  if (!result) throw new Error(`${method}: no result`);
  return BigInt(result);
}

async function solRead(
  config: VaultConfig,
  method: string,
  address: string,
  fetcher: typeof fetch,
): Promise<bigint> {
  const response = await fetcher(config.solRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params: [address, { commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(OUTSIDE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Solana RPC returned ${response.status}`);
  const body = (await response.json()) as {
    result?: { value: number | { amount: string } };
    error?: { message?: string; code?: number };
  };
  // A token account that doesn't exist yet holds nothing.
  if (method === "getTokenAccountBalance" && body.error) return 0n;
  const value = body.result?.value;
  if (value === undefined) throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
  return BigInt(typeof value === "number" ? value : value.amount);
}

function chainBalance(
  config: VaultConfig,
  asset: Asset,
  addresses: ChainAddresses,
  fetcher: typeof fetch,
): Promise<bigint> | null {
  if (asset === "Btc") return btcBalance(config, addresses.btc, fetcher);
  if (asset === "Sol" || "Spl" in asset) {
    if (!addresses.sol) return null;
    if (asset === "Sol") return solRead(config, "getBalance", addresses.sol, fetcher);
    const account = associatedTokenAccount(base58.decode(addresses.sol), Uint8Array.from(asset.Spl.mint));
    return solRead(config, "getTokenAccountBalance", base58.encode(account), fetcher);
  }
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
  addresses: ChainAddresses,
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

async function postJson<T>(url: string, body: unknown, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OUTSIDE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as T;
}

interface CovenantLog {
  standard: string;
  event: string;
  data?: unknown;
}

/** The vault's own events. Logs from other contracts in the same transaction are skipped. */
function parseEvents(logs: string[]): CovenantLog[] {
  const prefix = "EVENT_JSON:";
  return logs.flatMap((log) => {
    if (!log.startsWith(prefix)) return [];
    try {
      const parsed = JSON.parse(log.slice(prefix.length)) as CovenantLog;
      return parsed.standard === "covenant" ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function requestedOf(
  actions: ({ FunctionCall?: { method_name: string; args: string } } | string)[] | undefined,
): Payment[] {
  for (const action of actions ?? []) {
    if (typeof action === "object" && action.FunctionCall?.method_name === "propose_spend") {
      return requestedPayments(action.FunctionCall.args);
    }
  }
  return [];
}

/** Newest first. The contract keeps no history, so this reads its event logs from an indexer. */
export async function loadActivity(
  config: VaultConfig = defaultConfig,
  fetcher: typeof fetch = fetch,
): Promise<Activity[]> {
  const { account_txs: all } = await postJson<{
    account_txs: { transaction_hash: string; tx_block_timestamp: string }[];
  }>(`${config.txApiUrl}/v0/account`, { account_id: config.accountId }, fetcher);
  const recent = [...all]
    .sort((a, b) => Number(BigInt(b.tx_block_timestamp) - BigInt(a.tx_block_timestamp)))
    .slice(0, ACTIVITY_LIMIT);
  if (recent.length === 0) return [];
  const { transactions } = await postJson<{
    transactions: {
      transaction: {
        hash: string;
        actions?: ({ FunctionCall?: { method_name: string; args: string } } | string)[];
      };
      receipts: { execution_outcome: { outcome: { logs: string[] } } }[];
    }[];
  }>(
    `${config.txApiUrl}/v0/transactions`,
    { tx_hashes: recent.map((tx) => tx.transaction_hash) },
    fetcher,
  );
  const times = new Map(
    recent.map((tx) => [tx.transaction_hash, Number(BigInt(tx.tx_block_timestamp) / 1_000_000n)]),
  );
  return transactions
    .flatMap(({ transaction, receipts }) =>
      receipts
        .flatMap((receipt) => parseEvents(receipt.execution_outcome.outcome.logs))
        .map(({ event, data }): Activity => {
          const fields = (Array.isArray(data) ? data[0] : data) as Partial<Activity> | undefined;
          const payments = fields?.payments ?? [];
          return {
            ...fields,
            event,
            payments,
            ...(event === "spend_rejected" && payments.length === 0
              ? { requested: requestedOf(transaction.actions) }
              : {}),
            txHash: transaction.hash,
            at: times.get(transaction.hash) ?? 0,
          };
        }),
    )
    .sort((a, b) => b.at - a.at);
}

async function rpcQuery<T>(config: VaultConfig, params: object, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "query", method: "query", params: { finality: "final", ...params } }),
  });
  const body = (await response.json()) as { result?: T };
  if (!body.result) throw new Error("query: no result");
  return body.result;
}

export interface Provenance {
  /** Made by the factory, running its code, with no key that could replace that code. */
  standard: boolean;
  keys: number;
}

/**
 * Whether this vault is what the factory makes. Only a factory can create its own subaccounts, so
 * the name proves where the account came from, and the other two checks prove it hasn't changed.
 */
export async function loadProvenance(
  config: VaultConfig,
  factory: string = FACTORY_ID,
  fetcher: typeof fetch = fetch,
): Promise<Provenance> {
  const [account, access] = await Promise.all([
    rpcQuery<{ global_contract_hash?: string | null }>(
      config,
      { request_type: "view_account", account_id: config.accountId },
      fetcher,
    ),
    rpcQuery<{ keys: unknown[] }>(
      config,
      { request_type: "view_access_key_list", account_id: config.accountId },
      fetcher,
    ),
  ]);
  const keys = access.keys.length;
  if (!config.accountId.endsWith(`.${factory}`) || keys > 0) return { standard: false, keys };
  const expected = await view<string>({ ...config, accountId: factory }, "get_vault_code_hash", fetcher);
  return { standard: account.global_contract_hash === expected, keys };
}

/** The vaults this account made with the factory. */
export function vaultsOf(
  config: VaultConfig,
  owner: string,
  factory: string = FACTORY_ID,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  return view<string[]>({ ...config, accountId: factory }, "vaults_of", fetcher, { owner });
}

async function nearBalance(config: VaultConfig, fetcher: typeof fetch): Promise<string | null> {
  try {
    const { amount } = await rpcQuery<{ amount?: unknown }>(
      config,
      { request_type: "view_account", account_id: config.accountId },
      fetcher,
    );
    return typeof amount === "string" ? amount : null;
  } catch {
    return null;
  }
}

async function agentAllowance(config: VaultConfig, agent: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const { keys } = await rpcQuery<{
      keys: { access_key: { permission: unknown } }[];
    }>(config, { request_type: "view_access_key_list", account_id: agent }, fetcher);
    const allowances = keys.flatMap(({ access_key: { permission } }) => {
      if (typeof permission !== "object" || !permission || !("FunctionCall" in permission)) return [];
      const call = (permission as { FunctionCall: { allowance: string | null; receiver_id: string } }).FunctionCall;
      return call.receiver_id === config.accountId && call.allowance ? [BigInt(call.allowance)] : [];
    });
    if (allowances.length === 0) return null;
    return allowances.reduce((low, value) => (value < low ? value : low)).toString();
  } catch {
    return null;
  }
}

/** The id of the proposal with this proposer and description, searching from `from`. */
export async function findProposal(
  config: VaultConfig,
  dao: string,
  from: number,
  proposer: string,
  description: string,
  fetcher: typeof fetch = fetch,
): Promise<number | null> {
  const proposals = await view<{ id: number; proposer: string; description: string }[]>(
    { ...config, accountId: dao },
    "get_proposals",
    fetcher,
    { from_index: from, limit: 50 },
  );
  return proposals.find((p) => p.proposer === proposer && p.description === description)?.id ?? null;
}

/** Null for a guardian that's a plain account, which has no DAO methods to answer. */
async function loadGuardianDao(
  config: VaultConfig,
  guardian: string | null,
  fetcher: typeof fetch,
): Promise<GuardianDao | null> {
  if (!guardian) return null;
  const dao = { ...config, accountId: guardian };
  try {
    const [policy, nextProposalId] = await Promise.all([
      view<{ roles: { kind: unknown }[]; proposal_bond: string }>(dao, "get_policy", fetcher),
      view<number>(dao, "get_last_proposal_id", fetcher),
    ]);
    const council = policy.roles.flatMap(({ kind }) =>
      typeof kind === "object" && kind && "Group" in kind ? (kind.Group as string[]) : [],
    );
    return { accountId: guardian, council, proposalBond: policy.proposal_bond, nextProposalId };
  } catch {
    return null;
  }
}

export async function loadVault(
  config: VaultConfig = defaultConfig,
  fetcher: typeof fetch = fetch,
): Promise<VaultState> {
  const [roles, frozen, addresses, policy, queue, activity] = await Promise.all([
    view<Roles>(config, "get_roles", fetcher),
    view<boolean>(config, "is_frozen", fetcher),
    view<Addresses>(config, "get_addresses", fetcher),
    view<Policy>(config, "get_policy", fetcher),
    view<Pending[]>(config, "get_queue", fetcher),
    loadActivity(config, fetcher).catch(() => null),
  ]);
  const [guardianDao, near, allowance] = await Promise.all([
    loadGuardianDao(config, roles.guardian, fetcher),
    nearBalance(config, fetcher),
    agentAllowance(config, roles.agent, fetcher),
  ]);
  const btc = btcAddress(addresses.btc_pubkey);
  const balances = await Promise.all(
    policy.caps.map((cap) =>
      loadBalance(
        config,
        cap,
        { btc, evm: addresses.evm_address, ...(addresses.sol_address ? { sol: addresses.sol_address } : {}) },
        fetcher,
      ),
    ),
  );
  return {
    roles,
    guardianDao,
    frozen,
    btcAddress: btc,
    evmAddress: addresses.evm_address,
    ...(addresses.sol_address ? { solAddress: addresses.sol_address } : {}),
    policy,
    balances,
    queue,
    // Change back to the vault isn't a payment, so it's left out of what the agent asked for.
    activity:
      activity?.map((entry) =>
        entry.requested
          ? { ...entry, requested: entry.requested.filter((p) => p.asset !== "Btc" || scriptAddress(p.to) !== btc) }
          : entry,
      ) ?? null,
    nearBalance: near,
    agentAllowance: allowance,
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
    if (bytesToHex(token) === USDC_BASE_SEPOLIA) return { name: "USDC", unit: "base units" };
    return { name: `ERC-20 0x${bytesToHex(token)} (chain ${chain_id})`, unit: "base units" };
  }
  if (bytesToHex(asset.Spl.mint) === SOL_USDC_DEVNET_HEX) return { name: "USDC on Solana", unit: "base units" };
  return { name: `SPL ${base58.encode(Uint8Array.from(asset.Spl.mint))}`, unit: "base units" };
}

/** The testnet address for a P2WPKH output script, or its raw bytes for anything else. */
export function scriptAddress(script: number[]): string {
  const [version, length, ...program] = script;
  if (version === 0 && length === 20 && program.length === 20) {
    return bech32.encode("tb", [0, ...bech32.toWords(Uint8Array.from(program))]);
  }
  return bytesToHex(script);
}

/** Where a payment goes, as a person would read it. */
export function payeeAddress(chain: Payee["chain"], to: number[]): string {
  if (chain === "Solana") return base58.encode(Uint8Array.from(to));
  return chain === "Bitcoin" ? scriptAddress(to) : `0x${bytesToHex(to)}`;
}

/** Which chain an asset lives on. */
export function chainOfAsset(asset: Asset): Payee["chain"] {
  if (asset === "Btc") return "Bitcoin";
  if (asset === "Sol" || "Spl" in asset) return "Solana";
  return "Evm";
}

export function describePayee(payee: Payee): string {
  return `${payee.label} (${payee.chain === "Evm" ? "Base" : payee.chain}): ${payeeAddress(payee.chain, payee.to)}`;
}

/** What each refusal means, for someone who has never seen the error names. */
export const REFUSALS: Record<string, string> = {
  OutputNotWhitelisted: "it paid an address that isn't on the payee list",
  CalldataNotAllowed: "it was a contract call other than a plain token transfer",
  TokenNotAllowed: "it moved a token the policy doesn't allow",
  ValueWithTokenCall: "it sent ETH along with a token call",
  WrongChainId: "it was signed for another chain",
  GasCostTooHigh: "its gas could cost more than the cap",
  FeeTooHigh: "its fee was above the cap",
  PerTxCapExceeded: "it was larger than one payment may be",
  DailyCapExceeded: "it would pass the 24-hour limit",
  AssetNotCapped: "the policy sets no limit for that asset",
  PrevTxMismatch: "it lied about a coin's value",
  InputNotOwned: "it spent from something the vault doesn't own",
  TooManyInputs: "it used more coins than one spend may",
  UnsupportedScript: "it used an output type the vault refuses",
  NotYetExecutable: "it was still in its veto window",
  QueueFull: "the veto queue was full",
  SignFailed: "the signer failed, so the budget was returned",
  UnlistedNotAllowed: "it paid a new payee in an asset that new payees can't receive",
  UnlistedCapExceeded: "it would pass the 24-hour limit for new payees",
  MalformedTx: "the transaction was malformed",
};

export const explainRefusal = (error: string | undefined) =>
  (error && REFUSALS[error]) ?? "the contract refused it";

/** Names a payment's destination from the policy, or shows its raw bytes if it's since been removed. */
export function describePayment(payment: Payment, policy: Policy): string {
  const { unit, name } = describeAsset(payment.asset);
  const payee = policy.payees.find((p) => bytesToHex(p.to) === bytesToHex(payment.to));
  const to = payee?.label ?? `${payeeAddress(chainOfAsset(payment.asset), payment.to)} (new payee)`;
  return `${payment.amount} ${unit} of ${name} to ${to}`;
}

/** Whether a vault pays payees off its list, holding each payment for the longer window. */
export const holdsUnlisted = (policy: Policy) => policy.unlisted === "Hold";

export function unlistedDelaySeconds(policy: Policy): number {
  return Math.floor(Math.max(policy.veto_delay_ns, policy.unlisted_veto_delay_ns ?? 0) / 1_000_000_000);
}

/** Whole seconds until a nanosecond timestamp from the contract, never below zero. */
export function secondsUntil(timestampNs: string, nowMs: number): number {
  const left = BigInt(timestampNs) / 1_000_000_000n - BigInt(Math.floor(nowMs / 1000));
  return left > 0n ? Number(left) : 0;
}

/** Every proposal ends in another event, so listing it too would only double the rows. */
export const isShownInLog = (entry: Activity) => entry.event !== "spend_proposed";

/** Plain words for the log, so a screenshot shows what went through and what was stopped. */
export function describeActivity(entry: Activity): {
  outcome: string;
  stopped: boolean;
  signed?: boolean;
} {
  switch (entry.event) {
    case "spend_signed":
      return { outcome: "Signed", stopped: false, signed: true };
    case "spend_rejected":
      return {
        outcome: `Refused, because ${explainRefusal(entry.error)} (${entry.error ?? "unknown"})`,
        stopped: true,
      };
    case "spend_queued":
      return { outcome: "Queued for veto window", stopped: false };
    case "spend_vetoed":
      return { outcome: "Vetoed", stopped: true };
    case "frozen":
      return { outcome: `Frozen by ${entry.by ?? "unknown"}`, stopped: true };
    case "unfrozen":
      return { outcome: `Unfrozen by ${entry.by ?? "unknown"}`, stopped: false };
    case "policy_updated":
      return { outcome: "Policy updated", stopped: false };
    case "guardian_updated":
      return { outcome: "Guardian replaced", stopped: false };
    default:
      return { outcome: entry.event, stopped: false };
  }
}

/** Whole seconds, since the delay is only ever shown to a person. */
export function vetoDelaySeconds(policy: Policy): number {
  return Math.floor(policy.veto_delay_ns / 1_000_000_000);
}

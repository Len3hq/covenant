import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32, hex } from "@scure/base";

export interface VaultConfig {
  rpcUrl: string;
  accountId: string;
  btcApiUrl: string;
  evmRpcUrl: string;
  evmChainId: number;
  txApiUrl: string;
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
};

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
      transaction: { hash: string };
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
          return {
            ...fields,
            event,
            payments: fields?.payments ?? [],
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
      loadBalance(config, cap, { btc, evm: addresses.evm_address }, fetcher),
    ),
  );
  return {
    roles,
    guardianDao,
    frozen,
    btcAddress: btc,
    evmAddress: addresses.evm_address,
    policy,
    balances,
    queue,
    activity,
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
  return { name: `SPL ${bytesToHex(asset.Spl.mint)}`, unit: "base units" };
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
  return chain === "Bitcoin" ? scriptAddress(to) : `0x${bytesToHex(to)}`;
}

export function describePayee(payee: Payee): string {
  return `${payee.label} (${payee.chain === "Evm" ? "Base" : payee.chain}): ${payeeAddress(payee.chain, payee.to)}`;
}

/** What each refusal means, for someone who has never seen the error names. */
const REFUSALS: Record<string, string> = {
  OutputNotWhitelisted: "it paid an address that isn't on the payee list",
  CalldataNotAllowed: "it was a contract call other than a plain token transfer",
  TokenNotAllowed: "it moved a token the policy doesn't allow",
  ValueWithTokenCall: "it sent ETH along with a token call",
  WrongChainId: "it was signed for another chain",
  GasCostTooHigh: "its gas could cost more than the cap",
  FeeTooHigh: "its fee rate was above the cap",
  PerTxCapExceeded: "it was larger than one payment may be",
  DailyCapExceeded: "it would pass the 24-hour limit",
  AssetNotCapped: "the policy sets no limit for that asset",
  PrevTxMismatch: "it lied about a coin's value",
  InputNotOwned: "it spent a coin the vault doesn't own",
  TooManyInputs: "it used more coins than one spend may",
  UnsupportedScript: "it used an output type the vault refuses",
  NotYetExecutable: "it was still in its veto window",
  QueueFull: "the veto queue was full",
  SignFailed: "the signer failed, so the budget was returned",
  MalformedTx: "the transaction was malformed",
};

export const explainRefusal = (error: string | undefined) =>
  (error && REFUSALS[error]) ?? "the contract refused it";

/** Names a payment's destination from the policy, or shows its raw bytes if it's since been removed. */
export function describePayment(payment: Payment, policy: Policy): string {
  const { unit, name } = describeAsset(payment.asset);
  const payee = policy.payees.find((p) => bytesToHex(p.to) === bytesToHex(payment.to));
  const chain = "Btc" === payment.asset ? "Bitcoin" : "Evm";
  return `${payment.amount} ${unit} of ${name} to ${payee?.label ?? payeeAddress(chain, payment.to)}`;
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

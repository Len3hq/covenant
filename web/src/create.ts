import { base58, bech32, hex } from "@scure/base";
import { agentAccountId } from "./agent";
import { associatedTokenAccount, SOL_USDC_DEVNET, solanaKey } from "./solana";
import type { AssetCap, Payee, Policy } from "./vault";

/*
 * Turns the create-vault form into the arguments for `create_vault`. This only spares people a
 * failed transaction: the factory and the vault check everything again themselves.
 */

export const CHAIN_ID = 84532;
/** Tidepool's test USDC on Base Sepolia, which its faucet drips and its swaps use. */
export const USDC = "38d81431b9f76d9699af7517040d5221d9dea252";
const NEAR_DECIMALS = 24;
const ACCOUNT_LIMIT = 64;

/** A decimal amount as an integer base-unit string, using string arithmetic only. */
export function parseUnits(text: string, decimals: number): string {
  const trimmed = text.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new Error(`"${text}" isn't an amount`);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  const digits = `${match[1] ?? "0"}${fraction.padEnd(decimals, "0")}`;
  return digits.replace(/^0+(?=\d)/, "");
}

/** What a payee's address looks like to the contract, for the address formats it accepts. */
export function payeeBytes(chain: Payee["chain"], address: string): number[] {
  const trimmed = address.trim();
  if (chain === "Solana") return [...solanaKey(address)];
  if (chain === "Evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw new Error(`"${address}" isn't an EVM address`);
    return [...hex.decode(trimmed.slice(2).toLowerCase())];
  }
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(trimmed as `${string}1${string}`);
  } catch {
    throw new Error(`"${address}" isn't a Bitcoin testnet4 address`);
  }
  const [version, ...words] = decoded.words;
  const program = bech32.fromWords(words);
  if (decoded.prefix !== "tb" || version !== 0 || program.length !== 20) {
    throw new Error(`"${address}" isn't a tb1q address, the only kind the vault pays`);
  }
  return [0, 20, ...program];
}

export interface CapForm {
  perTx: string;
  per24h: string;
  queueAt: string;
  /** Most per 24 hours to payees off the list. Zero refuses them this asset. */
  unlisted24h: string;
}

export interface PayeeForm {
  label: string;
  chain: "Bitcoin" | "Evm" | "Solana";
  address: string;
}

export interface VaultForm {
  name: string;
  /** Create `agentName.<owner>` for the agent, or use an `agent` account that already exists. */
  agentMode: "create" | "existing";
  agentName: string;
  agent: string;
  guardian: string;
  deposit: string;
  vetoSeconds: string;
  /** Pay anyone, holding payments to unlisted payees, or pay only the list. */
  openPayees: boolean;
  /** Pay on other chains and in other tokens through Tidepool. */
  allowSwaps: boolean;
  unlistedSeconds: string;
  btc: CapForm;
  eth: CapForm;
  usdc: CapForm;
  sol: CapForm;
  solUsdc: CapForm;
  payees: PayeeForm[];
}

/** Low limits to start from, so the first vault someone makes is a safe one. */
export const STARTING_FORM: VaultForm = {
  name: "",
  agentMode: "create",
  agentName: "agent",
  agent: "",
  guardian: "",
  deposit: "1.5",
  vetoSeconds: "120",
  openPayees: true,
  allowSwaps: true,
  unlistedSeconds: "600",
  btc: { perTx: "0.005", per24h: "0.02", queueAt: "0.0025", unlisted24h: "0.004" },
  eth: { perTx: "0.01", per24h: "0.05", queueAt: "0.005", unlisted24h: "0.01" },
  usdc: { perTx: "50", per24h: "200", queueAt: "25", unlisted24h: "40" },
  sol: { perTx: "0.1", per24h: "0.5", queueAt: "0.05", unlisted24h: "0.1" },
  solUsdc: { perTx: "50", per24h: "200", queueAt: "25", unlisted24h: "40" },
  payees: [{ label: "", chain: "Bitcoin", address: "" }],
};

export function cap(
  asset: AssetCap["asset"],
  form: CapForm,
  decimals: number,
  name: string,
  open: boolean,
): AssetCap {
  const per_tx = parseUnits(form.perTx, decimals);
  const per_24h = parseUnits(form.per24h, decimals);
  const queue_at = parseUnits(form.queueAt, decimals);
  if (per_tx === "0" || per_24h === "0" || queue_at === "0") {
    throw new Error(`Every ${name} limit must be above zero`);
  }
  if (BigInt(queue_at) > BigInt(per_tx)) {
    throw new Error(`${name}: the veto threshold can't be above the per-payment cap`);
  }
  const unlisted_per_24h = open ? parseUnits(form.unlisted24h, decimals) : "0";
  if (BigInt(unlisted_per_24h) > BigInt(per_24h)) {
    throw new Error(`${name}: the new-payee limit can't be above the 24-hour limit`);
  }
  return { asset, per_tx, per_24h, queue_at, unlisted_per_24h };
}

function wholeSeconds(text: string, what: string): bigint {
  const seconds = text.trim();
  if (!/^\d+$/.test(seconds)) throw new Error(`${what} must be a whole number of seconds`);
  return BigInt(seconds);
}

/**
 * Tidepool on testnet: the key its quotes are signed with (on `maker.tidepool-sandbox.testnet`,
 * read on 10 Nov 2026), what the vault can swap from, and every bridged asset it delivers.
 */
const TIDEPOOL_MAKER_KEY = [
  6, 235, 22, 216, 170, 210, 199, 146, 202, 104, 197, 173, 237, 45, 75, 49, 234, 181, 78, 142, 10, 29, 246, 15,
  121, 58, 48, 247, 139, 208, 246, 77,
];
export const TIDEPOOL_DESTINATIONS = [
  "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
  "nep141:base-0xc15cf5600225302675604310094f134e88705e62.tp-omft.testnet",
  "nep141:base.tp-omft.testnet",
  "nep141:arb-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
  "nep141:arb-0xc15cf5600225302675604310094f134e88705e62.tp-omft.testnet",
  "nep141:arb.tp-omft.testnet",
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
  "nep141:eth-0x650f12ba31777de8ded47287a8cc86be737646fe.tp-omft.testnet",
  "nep141:eth.tp-omft.testnet",
  "nep141:bsc-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
  "nep141:bsc-0xc15cf5600225302675604310094f134e88705e62.tp-omft.testnet",
  "nep141:sol.tp-omft.testnet",
  "nep141:sol-d48c1adc423a64867ac91ed2e1c0df76da323235.tp-omft.testnet",
  "nep141:sol-4c5179da74eb695eb57e01b787c4937157cf2833.tp-omft.testnet",
  "nep141:stellar.tp-omft.testnet",
  "nep141:stellar-0da9087074a12ebeb5dcdc8bcf33cf163ab498fc.tp-omft.testnet",
  "nep141:stellar-c36e358585c12ac3f684b98be0c6682ca9c4665f.tp-omft.testnet",
  "nep141:sui.tp-omft.testnet",
  "nep141:sui-f6ecfe107e72d22b7a646dd2cc4f1b2876349c0c.tp-omft.testnet",
  "nep141:sui-add896332c906e599cee03f2154d067937d12a26.tp-omft.testnet",
  "nep141:xrp.tp-omft.testnet",
  "nep141:btc.tp-omft.testnet",
];

export function swapRules(): NonNullable<Policy["swap"]> {
  return {
    maker_key: TIDEPOOL_MAKER_KEY,
    origins: [
      { asset_id: "nep141:btc.tp-omft.testnet", asset: "Btc" },
      { asset_id: "nep141:base.tp-omft.testnet", asset: { EvmNative: { chain_id: CHAIN_ID } } },
      {
        asset_id: `nep141:base-0x${USDC}.tp-omft.testnet`,
        asset: { Erc20: { chain_id: CHAIN_ID, token: [...hex.decode(USDC)] } },
      },
      { asset_id: "nep141:sol.tp-omft.testnet", asset: "Sol" },
    ],
    destinations: TIDEPOOL_DESTINATIONS,
    payees: [],
    max_slippage_bps: 100,
    // A Bitcoin deposit needs a confirmation, so a quote must have an hour left when it's signed.
    min_deposit_window_ns: 3_600_000_000_000,
  };
}

/** Label for the USDC token account listed beside a Solana payee. */
export const solUsdcLabel = (label: string) => `${label} (USDC)`;

/** The payees as the contract lists them. A Solana payee's USDC account is listed beside it. */
export function payeesFrom(rows: PayeeForm[]): Payee[] {
  const solUsdc = base58.decode(SOL_USDC_DEVNET);
  return rows.flatMap(({ label, chain, address }): Payee[] => {
    if (!label.trim()) throw new Error("Every payee needs a name");
    const to = payeeBytes(chain, address);
    const payee = { chain, to, label: label.trim() };
    if (chain !== "Solana") return [payee];
    // Solana tokens go to a token account, not the wallet, so the wallet's USDC account is listed too.
    const tokens = associatedTokenAccount(Uint8Array.from(to), solUsdc);
    return [payee, { chain, to: [...tokens], label: solUsdcLabel(label.trim()) }];
  });
}

export function buildPolicy(form: VaultForm): Policy {
  const seconds = wholeSeconds(form.vetoSeconds, "The veto window");
  const unlistedSeconds = form.openPayees ? wholeSeconds(form.unlistedSeconds, "The new-payee window") : seconds;
  if (unlistedSeconds < seconds) {
    throw new Error("The new-payee window can't be shorter than the veto window");
  }
  const open = form.openPayees;
  const solUsdc = base58.decode(SOL_USDC_DEVNET);
  const payees = payeesFrom(form.payees);
  if (payees.length === 0 && !open) throw new Error("Add at least one payee, or the vault can pay no one");
  return {
    caps: [
      cap("Btc", form.btc, 8, "BTC", open),
      cap({ EvmNative: { chain_id: CHAIN_ID } }, form.eth, 18, "ETH", open),
      cap({ Erc20: { chain_id: CHAIN_ID, token: [...hex.decode(USDC)] } }, form.usdc, 6, "USDC", open),
      cap("Sol", form.sol, 9, "SOL", open),
      cap({ Spl: { mint: [...solUsdc] } }, form.solUsdc, 6, "Solana USDC", open),
    ],
    payees,
    btc_max_fee_rate: 50,
    btc_max_inputs: 3,
    evm_chain_ids: [CHAIN_ID],
    evm_max_gas_cost: "1000000000000000",
    veto_delay_ns: Number(seconds * 1_000_000_000n),
    unlisted: open ? "Hold" : "Refuse",
    unlisted_veto_delay_ns: Number(unlistedSeconds * 1_000_000_000n),
    swap: form.allowSwaps ? swapRules() : null,
    // 5,000 lamports of base fee, leaving room for a priority fee in busy times.
    sol_max_fee: "100000",
  };
}

export interface CreateRequest {
  args: { name: string; agent: string; guardian: string | null; policy: Policy };
  /** yoctoNEAR. */
  deposit: string;
}

export function buildRequest(form: VaultForm, factory: string, owner: string): CreateRequest {
  const name = form.name.trim();
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(name)) {
    throw new Error("The vault name can use lowercase letters, digits, - and _, with no dots");
  }
  if (`${name}.${factory}`.length > ACCOUNT_LIMIT) throw new Error("That vault name is too long");
  const agent = form.agentMode === "create" ? agentAccountId(form.agentName, owner) : form.agent.trim();
  const guardian = form.guardian.trim();
  if (!agent) throw new Error("Name the account your agent uses");
  if (agent === owner || agent === guardian) {
    throw new Error("The agent needs its own account, separate from the owner and guardian");
  }
  return {
    args: { name, agent, guardian: guardian || null, policy: buildPolicy(form) },
    deposit: parseUnits(form.deposit, NEAR_DECIMALS),
  };
}

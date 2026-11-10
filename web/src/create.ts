import { base58, bech32, hex } from "@scure/base";
import { associatedTokenAccount, SOL_USDC_DEVNET, solanaKey } from "./solana";
import type { AssetCap, Payee, Policy } from "./vault";

/*
 * Turns the create-vault form into the arguments for `create_vault`. This only spares people a
 * failed transaction: the factory and the vault check everything again themselves.
 */

export const CHAIN_ID = 84532;
const USDC = "036cbd53842c5426634e7929541ec2318f3dcf7e";
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
  agent: string;
  guardian: string;
  deposit: string;
  vetoSeconds: string;
  /** Pay anyone, holding payments to unlisted payees, or pay only the list. */
  openPayees: boolean;
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
  agent: "",
  guardian: "",
  deposit: "1.5",
  vetoSeconds: "120",
  openPayees: true,
  unlistedSeconds: "600",
  btc: { perTx: "0.005", per24h: "0.02", queueAt: "0.0025", unlisted24h: "0.004" },
  eth: { perTx: "0.01", per24h: "0.05", queueAt: "0.005", unlisted24h: "0.01" },
  usdc: { perTx: "50", per24h: "200", queueAt: "25", unlisted24h: "40" },
  sol: { perTx: "0.1", per24h: "0.5", queueAt: "0.05", unlisted24h: "0.1" },
  solUsdc: { perTx: "50", per24h: "200", queueAt: "25", unlisted24h: "40" },
  payees: [{ label: "", chain: "Bitcoin", address: "" }],
};

function cap(
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

export function buildPolicy(form: VaultForm): Policy {
  const seconds = wholeSeconds(form.vetoSeconds, "The veto window");
  const unlistedSeconds = form.openPayees ? wholeSeconds(form.unlistedSeconds, "The new-payee window") : seconds;
  if (unlistedSeconds < seconds) {
    throw new Error("The new-payee window can't be shorter than the veto window");
  }
  const open = form.openPayees;
  const solUsdc = base58.decode(SOL_USDC_DEVNET);
  const payees = form.payees.flatMap(({ label, chain, address }): Payee[] => {
    if (!label.trim()) throw new Error("Every payee needs a name");
    const to = payeeBytes(chain, address);
    const payee = { chain, to, label: label.trim() };
    if (chain !== "Solana") return [payee];
    // Solana tokens go to a token account, not the wallet, so the wallet's USDC account is listed too.
    const tokens = associatedTokenAccount(Uint8Array.from(to), solUsdc);
    return [payee, { chain, to: [...tokens], label: `${label.trim()} (USDC)` }];
  });
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
  const agent = form.agent.trim();
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

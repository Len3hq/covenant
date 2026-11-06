import {
  describeAsset,
  explainRefusal,
  isShownInLog,
  payeeAddress,
  vetoDelaySeconds,
  type Activity,
  type Asset,
  type Payment,
  type Policy,
} from "./vault";

/** Decimal places of an asset's human unit, or null when the dashboard doesn't know it. */
export function decimalsOf(asset: Asset): number | null {
  if (asset === "Btc") return 8;
  if (typeof asset === "object" && "EvmNative" in asset) return 18;
  if (describeAsset(asset).name === "USDC") return 6;
  return null;
}

/** The short symbol shown beside a human amount. */
export function symbolOf(asset: Asset): string {
  const { name } = describeAsset(asset);
  return name.startsWith("ETH") ? "ETH" : name;
}

/**
 * An integer base-unit amount in its human unit, for display only. The digits are moved with string
 * arithmetic, so no float ever touches an amount.
 */
export function formatUnits(amount: string, decimals: number, maxFraction = decimals): string {
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).replace(/^0+/, "") || "0";
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  let fraction = padded.slice(padded.length - decimals, padded.length - decimals + maxFraction);
  fraction = fraction.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** Thousands separators on an integer string. */
export const groupDigits = (amount: string) => amount.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** An amount as a person reads it: "0.0025 BTC". Falls back to base units for unknown assets. */
export function humanAmount(asset: Asset, amount: string): string {
  const decimals = decimalsOf(asset);
  if (decimals === null) return `${groupDigits(amount)} ${describeAsset(asset).unit}`;
  return `${formatUnits(amount, decimals)} ${symbolOf(asset)}`;
}

/** The same amount in the integer unit the contract counts in: "250,000 sats". */
export function baseAmount(asset: Asset, amount: string): string {
  return `${groupDigits(amount)} ${describeAsset(asset).unit}`;
}

export interface Rule {
  id: string;
  text: string;
  /** The `CovenantError` names this rule produces. */
  errors: string[];
}

/** The policy as numbered sentences, ending in the default that refuses everything else. */
export function rulesOf(policy: Policy): Rule[] {
  const rules: Rule[] = [];
  const add = (text: string, errors: string[]) =>
    rules.push({ id: `R${rules.length + 1}`, text, errors });
  const payees = policy.payees.map((p) => p.label).join(", ");
  add(
    policy.payees.length === 0
      ? "Pay no one: the payee list is empty"
      : `Pay only listed payees: ${payees}`,
    ["OutputNotWhitelisted", "UnsupportedScript"],
  );
  for (const cap of policy.caps) {
    add(
      `Refuse any single ${symbolOf(cap.asset)} payment over ${humanAmount(cap.asset, cap.per_tx)}`,
      ["PerTxCapExceeded"],
    );
  }
  for (const cap of policy.caps) {
    add(`Spend at most ${humanAmount(cap.asset, cap.per_24h)} in any 24 hours`, [
      "DailyCapExceeded",
    ]);
  }
  const delay = vetoDelaySeconds(policy);
  for (const cap of policy.caps) {
    add(
      `Hold ${symbolOf(cap.asset)} payments of ${humanAmount(cap.asset, cap.queue_at)} or more for ${delay} s, so a human can veto`,
      ["NotYetExecutable", "QueueFull"],
    );
  }
  add(`Bitcoin fee rate at most ${policy.btc_max_fee_rate} sat/vB, with at most ${policy.btc_max_inputs} coins per spend`, [
    "FeeTooHigh",
    "TooManyInputs",
    "InputNotOwned",
    "PrevTxMismatch",
  ]);
  add(
    `EVM: only chain ${policy.evm_chain_ids.join(", ")}, plain transfers only, gas at most ${formatUnits(policy.evm_max_gas_cost, 18)} ETH`,
    ["WrongChainId", "CalldataNotAllowed", "TokenNotAllowed", "ValueWithTokenCall", "GasCostTooHigh"],
  );
  add("Refuse everything else", ["AssetNotCapped", "MalformedTx"]);
  return rules;
}

/** The rule a refusal broke, so the log can point at it. */
export function ruleFor(rules: Rule[], error: string | undefined): Rule | undefined {
  if (!error) return undefined;
  return rules.find((rule) => rule.errors.includes(error));
}

export type Verdict = "blocked" | "signed" | "queued" | "vetoed" | "frozen" | "unfrozen" | "admin";

/** The one-word outcome of a log entry, which picks its colour and icon. */
export function verdictOf(entry: Activity): Verdict {
  switch (entry.event) {
    case "spend_rejected":
      return "blocked";
    case "spend_signed":
      return "signed";
    case "spend_queued":
      return "queued";
    case "spend_vetoed":
      return "vetoed";
    case "frozen":
      return "frozen";
    case "unfrozen":
      return "unfrozen";
    default:
      return "admin";
  }
}

export const VERDICT_WORD: Record<Verdict, string> = {
  blocked: "Blocked",
  signed: "Signed",
  queued: "Queued",
  vetoed: "Vetoed",
  frozen: "Frozen",
  unfrozen: "Unfrozen",
  admin: "Admin",
};

/** A sentence for the log, in the words a stranger would use. */
export function headline(entry: Activity): string {
  switch (entry.event) {
    case "spend_rejected":
      return `Refused, because ${explainRefusal(entry.error)}`;
    case "spend_signed":
      return "Signed by the MPC network, within policy";
    case "spend_queued":
      return "Held in the veto window";
    case "spend_vetoed":
      return "Vetoed before it could be signed";
    case "frozen":
      return `Vault frozen by ${entry.by ?? "unknown"}`;
    case "unfrozen":
      return `Vault unfrozen by ${entry.by ?? "unknown"}`;
    case "policy_updated":
      return "Policy updated by the owner";
    case "guardian_updated":
      return "Guardian replaced by the owner";
    default:
      return entry.event;
  }
}

/** The latest spend decision, which the hero card shows. */
export function latestDecision(activity: Activity[] | null): Activity | undefined {
  return activity?.find((entry) =>
    ["spend_rejected", "spend_signed", "spend_vetoed", "spend_queued"].includes(entry.event),
  );
}

/** The newest refusal, preferring one with a payment to show, which the hero card shows, or the newest decision when nothing was refused. */
export function featured(activity: Activity[] | null): Activity | undefined {
  const refusals = (activity ?? []).filter((entry) => entry.event === "spend_rejected");
  return (
    refusals.find((entry) => shownPayments(entry).payments.length > 0) ??
    refusals[0] ??
    latestDecision(activity)
  );
}

/** The contract's payments, or failing those what the agent asked for. */
export function shownPayments(entry: Activity): { payments: Payment[]; requested: boolean } {
  if (entry.payments.length > 0) return { payments: entry.payments, requested: false };
  return { payments: entry.requested ?? [], requested: (entry.requested ?? []).length > 0 };
}

export interface Tally {
  blocked: number;
  signed: number;
  /** Signed payments to an address that isn't a listed payee. The contract makes this zero. */
  signedOffList: number;
  events: number;
}

export function tally(activity: Activity[] | null, policy: Policy): Tally {
  const shown = (activity ?? []).filter(isShownInLog);
  const signed = shown.filter((entry) => entry.event === "spend_signed");
  return {
    blocked: shown.filter((entry) => entry.event === "spend_rejected").length,
    signed: signed.length,
    signedOffList: signed.flatMap((entry) => entry.payments).filter((p) => !isListed(p, policy)).length,
    events: shown.length,
  };
}

const hexOf = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** A payment's chain, from its asset. */
export const chainOfPayment = (payment: Payment) => (payment.asset === "Btc" ? "Bitcoin" : "Evm");

/** True when the payment goes to an address on the current payee list. */
export function isListed(payment: Payment, policy: Policy): boolean {
  return policy.payees.some((payee) => hexOf(payee.to) === hexOf(payment.to));
}

/** The payee's label, or null for an address the policy doesn't know. */
export function payeeLabel(payment: Payment, policy: Policy): string | null {
  return policy.payees.find((payee) => hexOf(payee.to) === hexOf(payment.to))?.label ?? null;
}

/** The address a payment goes to, as the chain's explorer would show it. */
export const paymentAddress = (payment: Payment) => payeeAddress(chainOfPayment(payment), payment.to);

/** "tb1ql3d4…fxgs": keeps both ends, which is what people compare. */
export function shorten(text: string, head = 8, tail = 6): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** "3 min ago", from milliseconds. */
export function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function explorerFor(chain: "Bitcoin" | "Evm" | "Solana", address: string): string {
  return chain === "Bitcoin"
    ? `https://mempool.space/testnet4/address/${address}`
    : `https://sepolia.basescan.org/address/${address}`;
}

export const nearTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

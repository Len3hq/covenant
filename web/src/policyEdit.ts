import { base58, hex } from "@scure/base";
import { cap, CHAIN_ID, payeesFrom, solUsdcLabel, swapRules, USDC, type CapForm, type PayeeForm } from "./create";
import { associatedTokenAccount, SOL_USDC_DEVNET } from "./solana";
import { formatUnits } from "./story";
import { payeeAddress, type Asset, type AssetCap, type Payee, type Policy } from "./vault";

/*
 * The live policy as a form a person can edit, and back. Only what owners change is in the form:
 * payees, limits, the veto windows, new payees and swaps. Everything else (fee and gas ceilings,
 * Tidepool's key and assets, caps for assets the form doesn't know) is kept exactly as it is. The
 * contract checks the whole policy again when it's saved.
 */

export type AssetKey = "btc" | "eth" | "usdc" | "sol" | "solUsdc";

export const ASSETS: { key: AssetKey; name: string; decimals: number; asset: Asset }[] = [
  { key: "btc", name: "BTC", decimals: 8, asset: "Btc" },
  { key: "eth", name: "ETH on Base", decimals: 18, asset: { EvmNative: { chain_id: CHAIN_ID } } },
  { key: "usdc", name: "USDC on Base", decimals: 6, asset: { Erc20: { chain_id: CHAIN_ID, token: [...hex.decode(USDC)] } } },
  { key: "sol", name: "SOL", decimals: 9, asset: "Sol" },
  { key: "solUsdc", name: "USDC on Solana", decimals: 6, asset: { Spl: { mint: [...base58.decode(SOL_USDC_DEVNET)] } } },
];

export interface EditForm {
  vetoSeconds: string;
  /** Pay anyone, holding payments to unlisted addresses, or pay only the list. */
  openPayees: boolean;
  unlistedSeconds: string;
  allowSwaps: boolean;
  /** Null: the vault doesn't pay in that asset. */
  caps: Record<AssetKey, CapForm | null>;
  payees: PayeeForm[];
}

const sameAsset = (a: Asset, b: Asset) => JSON.stringify(a) === JSON.stringify(b);
const plain = (amount: string, decimals: number) => formatUnits(amount, decimals).replace(/,/g, "");
const seconds = (ns: number | undefined) => String(Math.round((ns ?? 0) / 1e9));

/** The form for a live policy. */
export function formFromPolicy(policy: Policy): EditForm {
  const caps = Object.fromEntries(
    ASSETS.map(({ key, decimals, asset }) => {
      const found = policy.caps.find((c) => sameAsset(c.asset, asset));
      const form: CapForm | null = found
        ? {
            perTx: plain(found.per_tx, decimals),
            per24h: plain(found.per_24h, decimals),
            queueAt: plain(found.queue_at, decimals),
            unlisted24h: plain(found.unlisted_per_24h ?? "0", decimals),
          }
        : null;
      return [key, form];
    }),
  ) as Record<AssetKey, CapForm | null>;
  return {
    vetoSeconds: seconds(policy.veto_delay_ns),
    openPayees: policy.unlisted === "Hold",
    unlistedSeconds: seconds(policy.unlisted_veto_delay_ns ?? policy.veto_delay_ns),
    allowSwaps: Boolean(policy.swap),
    caps,
    payees: payeeRows(policy.payees),
  };
}

/** One row per payee, leaving out the USDC accounts listed beside Solana payees, which are redone. */
function payeeRows(payees: Payee[]): PayeeForm[] {
  const mint = base58.decode(SOL_USDC_DEVNET);
  const companions = new Set(
    payees
      .filter((p) => p.chain === "Solana")
      .map((p) => `${solUsdcLabel(p.label)}|${base58.encode(associatedTokenAccount(Uint8Array.from(p.to), mint))}`),
  );
  return payees
    .filter((p) => !(p.chain === "Solana" && companions.has(`${p.label}|${base58.encode(Uint8Array.from(p.to))}`)))
    .map((p) => ({ label: p.label, chain: p.chain, address: payeeAddress(p.chain, p.to) }));
}

function wholeSeconds(text: string, what: string): number {
  if (!/^\d+$/.test(text.trim())) throw new Error(`${what} is a whole number of seconds`);
  return Number(text.trim());
}

/** The policy to save: the form's rules over everything else the live policy says. */
export function policyFromForm(form: EditForm, live: Policy): Policy {
  const veto = wholeSeconds(form.vetoSeconds, "The veto window");
  const unlisted = form.openPayees ? wholeSeconds(form.unlistedSeconds, "The new-address window") : veto;
  if (unlisted < veto) throw new Error("The new-address window can't be shorter than the veto window");
  const known = ASSETS.map((a) => a.asset);
  const caps: AssetCap[] = [
    ...ASSETS.flatMap(({ key, name, decimals, asset }) => {
      const entry = form.caps[key];
      return entry ? [cap(asset, entry, decimals, name, form.openPayees)] : [];
    }),
    ...live.caps.filter((c) => !known.some((asset) => sameAsset(asset, c.asset))),
  ];
  if (caps.length === 0) throw new Error("Allow at least one asset, or the vault can pay nothing");
  const payees = payeesFrom(form.payees);
  if (payees.length === 0 && !form.openPayees) throw new Error("Add a payee, or allow new addresses, or the vault can pay no one");
  return {
    ...live,
    caps,
    payees,
    veto_delay_ns: veto * 1_000_000_000,
    unlisted: form.openPayees ? "Hold" : "Refuse",
    unlisted_veto_delay_ns: unlisted * 1_000_000_000,
    swap: form.allowSwaps ? (live.swap ?? swapRules()) : null,
  };
}

const minutes = (ns: number | undefined) => {
  const s = Math.round((ns ?? 0) / 1e9);
  return s % 60 === 0 ? `${s / 60} min` : `${s} s`;
};

/** What saving would change, in words, so the owner reads it before their wallet signs. */
export function describeChanges(before: Policy, after: Policy): string[] {
  const changes: string[] = [];
  const key = (p: Payee) => `${p.label} (${p.chain === "Evm" ? "Base" : p.chain}) ${payeeAddress(p.chain, p.to)}`;
  const was = new Set(before.payees.map(key));
  const now = new Set(after.payees.map(key));
  for (const p of now) if (!was.has(p)) changes.push(`Adds payee ${p}`);
  for (const p of was) if (!now.has(p)) changes.push(`Removes payee ${p}`);
  if (before.veto_delay_ns !== after.veto_delay_ns) {
    changes.push(`Veto window: ${minutes(before.veto_delay_ns)} → ${minutes(after.veto_delay_ns)}`);
  }
  if ((before.unlisted ?? "Refuse") !== after.unlisted) {
    changes.push(after.unlisted === "Hold" ? "New addresses: refused → held for your veto" : "New addresses: held → refused");
  } else if (after.unlisted === "Hold" && before.unlisted_veto_delay_ns !== after.unlisted_veto_delay_ns) {
    changes.push(`New-address window: ${minutes(before.unlisted_veto_delay_ns)} → ${minutes(after.unlisted_veto_delay_ns)}`);
  }
  if (Boolean(before.swap) !== Boolean(after.swap)) changes.push(after.swap ? "Turns swaps on" : "Turns swaps off");
  const fields: [keyof AssetCap, string][] = [
    ["per_tx", "most per payment"],
    ["per_24h", "most per 24 hours"],
    ["queue_at", "held for veto from"],
    ["unlisted_per_24h", "new addresses, most per 24 hours"],
  ];
  for (const { name, decimals, asset } of ASSETS) {
    const old = before.caps.find((c) => sameAsset(c.asset, asset));
    const next = after.caps.find((c) => sameAsset(c.asset, asset));
    if (!old && next) changes.push(`Allows ${name}`);
    else if (old && !next) changes.push(`Stops paying in ${name}`);
    else if (old && next) {
      for (const [field, label] of fields) {
        const a = String(old[field] ?? "0");
        const b = String(next[field] ?? "0");
        if (a !== b) changes.push(`${name}, ${label}: ${formatUnits(a, decimals)} → ${formatUnits(b, decimals)}`);
      }
    }
  }
  return changes;
}

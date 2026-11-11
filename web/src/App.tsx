import { useCallback, useEffect, useState } from "react";
import { ConnectAgent } from "./ConnectAgent";
import { CreateVault } from "./CreateVault";
import { ConnectClaude } from "./ConnectClaude";
import { CONNECTOR_URL, hostedPublicKey } from "./hosted";
import { HostedConnect } from "./HostedConnect";
import { describeChanges, formFromPolicy, policyFromForm, ASSETS as POLICY_ASSETS, type AssetKey, type EditForm } from "./policyEdit";
import { CapFields, Field, Payees } from "./PolicyFields";
import { STARTING_FORM, type CapForm } from "./create";
import { Docs } from "./Docs";
import {
  accountExists,
  addAgentKeyTransaction,
  agentAccountId,
  createAgentTransaction,
  newAgentKey,
  removeAgentKeyTransaction,
} from "./agent";
import { FAUCET_LINKS, TIDEPOOL_FAUCET, faucetTargets } from "./faucet";
import {
  baseAmount,
  explorerFor,
  headline,
  humanAmount,
  isListed,
  featured,
  shownPayments,
  nearTx,
  payeeLabel,
  paymentAddress,
  chainOfPayment,
  ruleFor,
  rulesOf,
  shorten,
  symbolOf,
  tally,
  timeAgo,
  verdictOf,
  VERDICT_WORD,
  type Rule,
  type Verdict,
} from "./story";
import {
  defaultConfig,
  describeAsset,
  findProposal,
  formatNear,
  isShownInLog,
  loadVault,
  describeSwap,
  payeeAddress,
  secondsUntil,
  vetoDelaySeconds,
  warnings,
  vaultFromUrl,
  withRpcFallback,
  loadProvenance,
  type Activity,
  type Provenance,
  type Balance,
  type Payment,
  type Pending,
  type Policy,
  type VaultState,
} from "./vault";
import {
  canStop,
  connectedAccount,
  parsePolicy,
  roleOf,
  act as runAction,
  send,
  vaultCall,
  walletConnector,
  type Role,
} from "./wallet";

const REFRESH_MS = 5_000;
const REPO_URL = "https://github.com/Len3hq/covenant";
const SIGNER = "v1.signer-prod.testnet";
const rpcFetch = withRpcFallback(defaultConfig.rpcUrl);
const search = typeof location === "undefined" ? "" : location.search;
const config = { ...defaultConfig, accountId: vaultFromUrl(search, defaultConfig.accountId) };
const creating = new URLSearchParams(search).has("create");
/** Claude's sign-in to the hosted connector: `?connect=<request>&connector=<url>`. */
const connectRequest = new URLSearchParams(search).get("connect");
const connectorParam = new URLSearchParams(search).get("connector") ?? "";
const reading = new URLSearchParams(search).has("docs");

export type VaultStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; vault: VaultState };

/** What the page can ask a connected wallet to do. Absent when rendering without one. */
export interface Controls {
  account: string | null;
  role: Role;
  message: string | null;
  connect(): void;
  disconnect(): void;
  act(method: string, args: object): void;
  /** For the owner: a new agent account and key. `switchAgent` then points the vault at it. */
  replaceAgent?(name: string): void;
  /**
   * The second signature, on its own click. Browsers block a wallet's pop-up that opens long after
   * the click, so it can't follow the first transaction by itself.
   */
  switchAgent?(): void;
  /** An agent account that's ready, waiting for `switchAgent`. */
  pendingAgent?: string | null;
  /** The key of an agent made on this page, shown once. */
  newAgent?: { vault: string; agent: string; secret: string } | null;
  /** For the agent account itself: a new key scoped to this vault, shown once. */
  addAgentKey?(): void;
  removeAgentKey?(publicKey: string): void;
}

/** The clock, ticking once a second so countdowns move between refreshes. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const ICON: Record<Verdict, string> = {
  blocked: "✕",
  signed: "✓",
  queued: "◷",
  vetoed: "⦸",
  frozen: "❄",
  unfrozen: "◌",
  admin: "•",
};

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2 4 7v8c0 7.5 5.1 13.6 12 15 6.9-1.4 12-7.5 12-15V7L16 2Z" />
      <path className="mark-check" d="M11 16.5 14.5 20 21.5 12.5" />
    </svg>
  );
}

function roleLabel(role: Role): string {
  switch (role) {
    case "owner":
      return "Owner: set policy, veto, freeze and unfreeze";
    case "guardian":
      return "Guardian: veto and freeze";
    case "council":
      return "Guardian DAO council: veto and freeze by vote";
    case "none":
      return "No role on this vault";
  }
}

function VaultPicker() {
  const [value, setValue] = useState("");
  return (
    <form className="picker" action="" method="get">
      <input
        name="vault"
        aria-label="Open a vault by its account name"
        placeholder="Open a vault: name.testnet"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        required
      />
      <button className="ghost">Open</button>
    </form>
  );
}

function TopBar({
  accountId,
  vault,
  controls,
}: {
  accountId?: string;
  vault: VaultState | null;
  controls?: Controls;
}) {
  return (
    <header className="topbar">
      <a className="brand" href="./">
        <Mark />
        <span>Covenant</span>
      </a>
      {accountId && <span className="chip mono">{accountId}</span>}
      <span className="chip">NEAR testnet</span>
      {vault && (
        <span className={`pill ${vault.frozen ? "pill-frozen" : "pill-live"}`}>
          <span className="dot" />
          {vault.frozen ? "Frozen" : "Enforcing"}
        </span>
      )}
      <span className="spacer" />
      <VaultPicker />
      <a className="docs-link" href="?docs">
        Docs
      </a>
      <a className="create-link" href="?create">
        Create a vault
      </a>
      {controls &&
        (controls.account ? (
          <span className="who">
            <span className="mono">{controls.account}</span>
            <span className="muted">{roleLabel(controls.role)}</span>
            <button className="ghost" onClick={controls.disconnect}>
              Sign out
            </button>
          </span>
        ) : (
          <button className="primary" onClick={controls.connect}>
            Connect a NEAR wallet
          </button>
        ))}
    </header>
  );
}

function FrozenBanner({ vault, activity }: { vault: VaultState; activity: Activity[] | null }) {
  if (!vault.frozen) return null;
  const by = activity?.find((entry) => entry.event === "frozen")?.by;
  return (
    <div className="banner banner-frozen" role="alert">
      <strong>❄ Vault frozen{by ? ` by ${by}` : ""}.</strong> Nothing on any chain can be signed until
      the owner unfreezes it. Vetoes still work.
    </div>
  );
}

function Warnings({ vault }: { vault: VaultState }) {
  const found = warnings(vault);
  if (found.length === 0) return null;
  return (
    <div className="banner banner-warn" role="alert">
      <strong>Needs attention</strong>
      <ul>
        {found.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function Hero({ vault }: { vault: VaultState }) {
  const counts = tally(vault.activity, vault.policy);
  return (
    <section className="hero-copy">
      <p className="eyebrow">AI security · Agent economy · Chain Signatures</p>
      <h1>
        The agent can be fooled.
        <br />
        <span className="accent">The vault can't.</span>
      </h1>
      <p className="lede">
        An AI agent pays bills on Bitcoin and Base. It holds no keys. Every payment it asks for is
        checked by a NEAR contract, and only then does NEAR's MPC network sign it. There's no AI in
        the security path.
      </p>
      <div className="stats">
        <Stat value={counts.blocked} label="Payments refused" tone="blocked" />
        <Stat value={counts.signed} label="Payments signed" tone="signed" />
        <Stat value={counts.signedOffList} label="Signed to an unlisted address" tone="neutral" />
      </div>
      <p className="muted small">From the vault's last {counts.events} on-chain events.</p>
    </section>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className={`stat stat-${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function PaymentLine({ payment, policy }: { payment: Payment; policy: Policy }) {
  const address = paymentAddress(payment);
  const label = payeeLabel(payment, policy);
  const listed = isListed(payment, policy);
  return (
    <div className={`payment ${listed ? "listed" : "unlisted"}`}>
      <span className="amount">{humanAmount(payment.asset, payment.amount)}</span>
      <span className="arrow">→</span>
      <a className="mono addr" href={explorerFor(chainOfPayment(payment), address)} title={address}>
        {label ? `${label} · ${shorten(address)}` : shorten(address, 12, 8)}
      </a>
      {!listed && <span className="tag tag-blocked">Not a payee</span>}
    </div>
  );
}

function VerdictCard({
  entry,
  policy,
  rules,
  now,
}: {
  entry: Activity | undefined;
  policy: Policy;
  rules: Rule[];
  now: number;
}) {
  if (!entry) {
    return (
      <section className="verdict verdict-idle">
        <p className="eyebrow">Latest decision</p>
        <p className="verdict-word">Waiting</p>
        <p className="muted">The agent hasn't asked for a payment yet.</p>
      </section>
    );
  }
  const verdict = verdictOf(entry);
  const rule = ruleFor(rules, entry.error);
  const { payments, requested } = shownPayments(entry);
  const first = payments[0];
  const title = verdict === "blocked" ? "Latest refusal" : "Latest decision";
  return (
    <section className={`verdict verdict-${verdict}`} key={entry.txHash} aria-live="polite">
      <div className="verdict-head">
        <p className="eyebrow">
          {title} · {timeAgo(entry.at, now)}
        </p>
        <a className="mono small" href={nearTx(entry.txHash)}>
          NEAR tx {entry.txHash.slice(0, 8)} ↗
        </a>
      </div>
      <p className="verdict-word">
        <span className="verdict-icon">{ICON[verdict]}</span>
        {VERDICT_WORD[verdict]}
      </p>
      <p className="verdict-why">{headline(entry)}.</p>
      {entry.error && (
        <p className="verdict-code">
          <code>{entry.error}</code>
          {rule && <span className="tag">Rule {rule.id}</span>}
        </p>
      )}
      {payments.length > 0 && (
        <div className="verdict-payments">
          <p className="label">{requested ? "The agent asked to pay" : "Payments"}</p>
          {payments.map((payment) => (
            <PaymentLine key={payment.to.join()} payment={payment} policy={policy} />
          ))}
          {payments.some((payment) => !isListed(payment, policy)) && (
            <p className="verdict-allowed">
              Allowed payees:{" "}
              {policy.payees
                .map((payee) => `${payee.label} (${shorten(payeeAddress(payee.chain, payee.to))})`)
                .join(", ") || "none"}
            </p>
          )}
        </div>
      )}
      {verdict === "blocked" && (
        <div className="verdict-foot">
          <span className="big">{first ? `0 ${symbolOf(first.asset)}` : "0"}</span>
          <span>
            {first ? "moved." : "Nothing moved."} The contract never asked the MPC network for a
            signature.
          </span>
        </div>
      )}
      {verdict === "signed" && first && (
        <div className="verdict-foot quiet">
          <span>
            Paid to {payeeLabel(first, policy) ?? "a listed payee"}, within every cap. The signature
            was produced by {SIGNER}.
          </span>
        </div>
      )}
    </section>
  );
}

function Flow({ entry }: { entry: Activity | undefined }) {
  const verdict = entry ? verdictOf(entry) : "idle";
  const chain = entry?.chain === "Evm" ? "Base Sepolia" : entry?.chain === "Bitcoin" ? "Bitcoin testnet4" : "Bitcoin · Base";
  const stop =
    verdict === "blocked" ? "Refused by policy" : verdict === "queued" ? "Held for veto" : verdict === "vetoed" ? "Vetoed" : null;
  return (
    <section className={`flow flow-${verdict}`} key={entry?.txHash ?? "idle"} aria-label="How a payment flows">
      <FlowNode step="1" title="AI agent" detail="Proposes a payment. Holds no keys." />
      <FlowEdge index={1} />
      <FlowNode step="2" title="Covenant contract" detail="Checks every rule on NEAR." brand />
      <FlowEdge index={2} broken={stop} />
      <FlowNode step="3" title="MPC signer" detail={SIGNER} downstream />
      <FlowEdge index={3} downstream />
      <FlowNode step="4" title={chain} detail="Broadcast by anyone." downstream />
    </section>
  );
}

function FlowNode({
  step,
  title,
  detail,
  brand,
  downstream,
}: {
  step: string;
  title: string;
  detail: string;
  brand?: boolean;
  downstream?: boolean;
}) {
  return (
    <div className={`node node-${step} ${brand ? "node-brand" : ""} ${downstream ? "downstream" : ""}`}>
      <span className="node-step mono">{step}</span>
      <span className="node-title">{title}</span>
      <span className="node-detail">{detail}</span>
    </div>
  );
}

function FlowEdge({ index, broken, downstream }: { index: number; broken?: string | null; downstream?: boolean }) {
  return (
    <div className={`edge edge-${index} ${broken ? "broken" : ""} ${downstream ? "downstream" : ""}`}>
      <span className="edge-line" />
      {broken && <span className="edge-stop">✕ {broken}</span>}
    </div>
  );
}

const FILTERS = ["All", "Blocked", "Signed"] as const;
const CHAINS = ["All", "Bitcoin", "Evm"] as const;

function Feed({
  activity,
  policy,
  rules,
  now,
}: {
  activity: Activity[] | null;
  policy: Policy;
  rules: Rule[];
  now: number;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [chain, setChain] = useState<(typeof CHAINS)[number]>("All");
  const shown = (activity ?? []).filter(
    (entry) =>
      isShownInLog(entry) &&
      (chain === "All" || entry.chain === chain) &&
      (filter === "All" ||
        (filter === "Blocked" && verdictOf(entry) === "blocked") ||
        (filter === "Signed" && verdictOf(entry) === "signed")),
  );
  return (
    <section className="card feed">
      <div className="card-head">
        <h2>
          <span className="live-dot" /> Decision log
        </h2>
        <div className="filters">
          {FILTERS.map((option) => (
            <button key={option} aria-pressed={filter === option} onClick={() => setFilter(option)}>
              {option}
            </button>
          ))}
          <span className="divider" />
          {CHAINS.map((option) => (
            <button key={option} aria-pressed={chain === option} onClick={() => setChain(option)}>
              {option === "Evm" ? "Base" : option === "All" ? "Any chain" : option}
            </button>
          ))}
        </div>
      </div>
      {activity === null && <p className="empty">Unavailable: the transaction API couldn't be read.</p>}
      {activity?.length === 0 && <p className="empty">Nothing has happened yet.</p>}
      <ol className="rows">
        {shown.map((entry, index) => {
          const verdict = verdictOf(entry);
          const rule = ruleFor(rules, entry.error);
          const { payments, requested } = shownPayments(entry);
          return (
            <li key={`${entry.txHash}-${index}`} className={`row row-${verdict}`}>
              <span className="row-verdict">
                <span className="row-icon">{ICON[verdict]}</span>
                {VERDICT_WORD[verdict]}
              </span>
              <div className="row-body">
                <p className="row-head">
                  {headline(entry)}
                  {entry.error && <code>{entry.error}</code>}
                  {rule && <span className="tag">{rule.id}</span>}
                </p>
                {requested && <p className="label">Asked for</p>}
                {payments.map((payment) => (
                  <PaymentLine key={payment.to.join()} payment={payment} policy={policy} />
                ))}
                {entry.swap && <p className="muted small">{describeSwap(entry.swap)}</p>}
              </div>
              <div className="row-meta">
                {entry.chain && <span className="chip">{entry.chain === "Evm" ? "Base" : entry.chain}</span>}
                <time dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toISOString()}>
                  {timeAgo(entry.at, now)}
                </time>
                <a className="mono" href={nearTx(entry.txHash)}>
                  {entry.txHash.slice(0, 8)} ↗
                </a>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function QueueCard({
  queue,
  policy,
  now,
  controls,
}: {
  queue: Pending[];
  policy: Policy;
  now: number;
  controls?: Controls;
}) {
  const canVeto = controls ? canStop(controls.role) : false;
  const delay = vetoDelaySeconds(policy);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Veto queue</h2>
        <span className="muted small">{delay} s window</span>
      </div>
      {queue.length === 0 ? (
        <p className="empty">
          Nothing is waiting. Large payments wait here for {delay} s, so the owner or guardian can veto
          them before they're signed.
        </p>
      ) : (
        <ul className="queue">
          {queue.map((spend) => {
            const left = secondsUntil(spend.executable_at, now);
            const share = delay > 0 ? Math.min(100, Math.round((left * 100) / delay)) : 0;
            return (
              <li key={spend.id} className="queued">
                <div className="queue-top">
                  <span className="mono">#{spend.id}</span>
                  <span className="countdown mono">{left > 0 ? `${left} s` : "Ready to execute"}</span>
                </div>
                <div className="meter warn">
                  <span style={{ width: `${share}%` }} />
                </div>
                {spend.payments.map((payment) => (
                  <PaymentLine key={payment.to.join()} payment={payment} policy={policy} />
                ))}
                {canVeto && (
                  <button className="danger" onClick={() => controls?.act("veto", { id: spend.id })}>
                    Veto
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">The owner or guardian can veto any of these until they execute.</p>
    </section>
  );
}

function BudgetCard({ balances, policy }: { balances: Balance[]; policy: Policy }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Budgets</h2>
        <span className="muted small">Rolling 24 h</span>
      </div>
      <ul className="budgets">
        {balances.map((balance) => {
          const cap = policy.caps.find((c) => describeAsset(c.asset).name === balance.name);
          const spent = BigInt(balance.spent24h);
          const limit = BigInt(balance.per24h);
          const share = limit > 0n ? Number((spent * 100n) / limit) : 0;
          return (
            <li key={balance.name}>
              <div className="budget-top">
                <span className="budget-name">{balance.name}</span>
                <span className="budget-held">
                  {balance.balance === null
                    ? "Balance unavailable"
                    : cap
                      ? humanAmount(cap.asset, balance.balance)
                      : `${balance.balance} ${balance.unit}`}
                </span>
              </div>
              <div className="meter">
                <span style={{ width: `${Math.min(100, Math.max(share, spent > 0n ? 2 : 0))}%` }} />
              </div>
              <p className="budget-sub mono">
                {cap ? baseAmount(cap.asset, balance.spent24h) : balance.spent24h} of{" "}
                {cap ? baseAmount(cap.asset, balance.per24h) : balance.per24h} spent
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RulesCard({ policy, rules, controls }: { policy: Policy; rules: Rule[]; controls?: Controls }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Rules the contract enforces</h2>
      </div>
      <ol className="rules">
        {rules.map((rule) => (
          <li key={rule.id} className={rule.text === "Refuse everything else" ? "rule-default" : undefined}>
            <span className="tag">{rule.id}</span>
            <span>{rule.text}</span>
          </li>
        ))}
      </ol>
      <details className="payees">
        <summary>Payee list ({policy.payees.length})</summary>
        <p className="muted small">Each vault's owner chooses these names. Check the addresses.</p>
        {policy.payees.length === 0 ? (
          <p className="muted">None, so every payment is refused.</p>
        ) : (
          <ul>
            {policy.payees.map((payee) => {
              const address = payeeAddress(payee.chain, payee.to);
              return (
                <li key={address}>
                  <span>
                    {payee.label} <span className="muted">({payee.chain === "Evm" ? "Base" : payee.chain})</span>
                  </span>
                  <a className="mono small" href={explorerFor(payee.chain, address)}>
                    {address}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </details>
      {controls?.role === "owner" && <PolicyEditor key={JSON.stringify(policy)} policy={policy} controls={controls} />}
    </section>
  );
}

function PolicyEditor({ policy, controls }: { policy: Policy; controls: Controls }) {
  const [form, setForm] = useState<EditForm>(() => formFromPolicy(policy));
  const [review, setReview] = useState<{ next: Policy; changes: string[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [json, setJson] = useState(() => JSON.stringify(policy, null, 2));
  const edit = (next: EditForm) => {
    setForm(next);
    setReview(null);
    setProblem(null);
  };
  const check = () => {
    try {
      const next = policyFromForm(form, policy);
      setReview({ next, changes: describeChanges(policy, next) });
      setProblem(null);
    } catch (error) {
      setReview(null);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <details className="policy-editor">
      <summary>Change the rules</summary>
      <Payees payees={form.payees} open={form.openPayees} onChange={(payees) => edit({ ...form, payees })} />
      <fieldset className="payee-mode">
        <legend>Addresses that aren't payees</legend>
        <label>
          <input type="radio" name="edit-open" checked={form.openPayees} onChange={() => edit({ ...form, openPayees: true })} />{" "}
          Pay them, after a wait so you can veto
        </label>
        <label>
          <input type="radio" name="edit-open" checked={!form.openPayees} onChange={() => edit({ ...form, openPayees: false })} />{" "}
          Refuse them
        </label>
      </fieldset>
      <Field
        label="Veto window for large payments, in seconds"
        value={form.vetoSeconds}
        hint={windowHint(form.vetoSeconds)}
        onChange={(vetoSeconds) => edit({ ...form, vetoSeconds })}
      />
      {form.openPayees && (
        <Field
          label="Wait before paying a new address, in seconds"
          value={form.unlistedSeconds}
          hint={windowHint(form.unlistedSeconds)}
          onChange={(unlistedSeconds) => edit({ ...form, unlistedSeconds })}
        />
      )}
      <h3>Limits</h3>
      <p className="muted small">In whole coins, such as 0.005 BTC or 50 USDC.</p>
      {POLICY_ASSETS.map(({ key, name }) => {
        const entry = form.caps[key];
        return entry ? (
          <div key={key}>
            <CapFields name={name} cap={entry} open={form.openPayees} onChange={(next) => edit({ ...form, caps: { ...form.caps, [key]: next } })} />
            <button type="button" className="ghost" onClick={() => edit({ ...form, caps: { ...form.caps, [key]: null } })}>
              Stop paying in {name}
            </button>
          </div>
        ) : (
          <p key={key} className="muted small">
            {name} isn't allowed.{" "}
            <button type="button" className="ghost" onClick={() => edit({ ...form, caps: { ...form.caps, [key]: STARTING_CAPS[key] } })}>
              Allow {name}
            </button>
          </p>
        );
      })}
      <label className="check">
        <input type="checkbox" checked={form.allowSwaps} onChange={(event) => edit({ ...form, allowSwaps: event.target.checked })} /> Allow
        payments on other chains and in other tokens, through Tidepool's signed quotes
      </label>
      <button type="button" className="primary" onClick={check}>
        Review changes
      </button>
      {problem && (
        <p className="banner banner-frozen" role="alert">
          {problem}
        </p>
      )}
      {review && (
        <div className="review">
          {review.changes.length === 0 ? (
            <p className="muted small">Nothing would change.</p>
          ) : (
            <>
              <p>Saving will:</p>
              <ul>
                {review.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              <button type="button" className="primary" onClick={() => controls.act("set_policy", { policy: review.next })}>
                Save with your wallet
              </button>
              <p className="muted small">The vault checks every rule again, and refuses anything it doesn't accept.</p>
            </>
          )}
        </div>
      )}
      <details>
        <summary>Advanced: edit the policy as JSON</summary>
        <p className="muted small">Every setting, including the ones above. A mistake here is refused by the vault, not fixed.</p>
        <textarea aria-label="Policy JSON" rows={16} value={json} onChange={(event) => setJson(event.target.value)} />
        <button
          type="button"
          className="ghost"
          onClick={() => {
            try {
              controls.act("set_policy", { policy: parsePolicy(json) });
              setProblem(null);
            } catch (error) {
              setProblem(String(error));
            }
          }}
        >
          Save the JSON
        </button>
      </details>
    </details>
  );
}

/** "600" as "10 minutes", under the field. */
function windowHint(text: string): string {
  const s = Number(text.trim());
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return `${s} seconds`;
  const m = s / 60;
  return m < 60 ? `${Number(m.toFixed(1))} minutes` : `${Number((m / 60).toFixed(1))} hours`;
}

const STARTING_CAPS: Record<AssetKey, CapForm> = {
  btc: STARTING_FORM.btc,
  eth: STARTING_FORM.eth,
  usdc: STARTING_FORM.usdc,
  sol: STARTING_FORM.sol,
  solUsdc: STARTING_FORM.solUsdc,
};

function ProvenanceLine({ provenance }: { provenance?: Provenance | null }) {
  if (!provenance) return null;
  if (provenance.standard) {
    return (
      <p className="provenance verified">
        ✓ Standard vault: made by the factory, running its shared code, with no keys. Nobody can change
        its code, including us.
      </p>
    );
  }
  return (
    <p className="provenance">
      Not a standard vault: it was deployed directly, not by the factory
      {provenance.keys > 0
        ? `, and ${provenance.keys} access ${provenance.keys === 1 ? "key" : "keys"} could replace its code`
        : ""}
      . Check its code before you trust it.
    </p>
  );
}

/** The enclave's public key, when a hosted connector is set up. */
function useHostedKey(): string | null {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    if (!CONNECTOR_URL) return;
    let current = true;
    hostedPublicKey(CONNECTOR_URL)
      .then((found) => current && setKey(found))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return key;
}

/** The agent's keys, and for the agent account itself, adding and removing vault keys. */
function AgentKeysCard({ vault, controls }: { vault: VaultState; controls?: Controls }) {
  const keys = vault.agentKeys ?? null;
  const hostedKey = useHostedKey();
  const signedInAsAgent = controls?.account === vault.roles.agent;
  const forVault = keys?.filter((key) => key.forVault) ?? [];
  const full = keys?.some((key) => key.full) ?? false;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Agent keys</h2>
      </div>
      {keys === null ? (
        <p className="muted small">The agent's keys couldn't be read.</p>
      ) : (
        <>
          <p className="muted small">
            {forVault.length === 0
              ? `${vault.roles.agent} has no key for this vault yet, so the agent can't ask for payments.`
              : `${vault.roles.agent} has ${forVault.length} key${forVault.length === 1 ? "" : "s"} that can only ask this vault for payments.`}{" "}
            {full ? "It also has a full-access key, held by whoever made it." : "It has no full-access key."}
          </p>
          <ul className="key-list">
            {forVault.map((key) => (
              <li key={key.publicKey}>
                <span className="mono small">{key.publicKey.slice(0, 20)}…</span>{" "}
                {key.publicKey === hostedKey && (
                  <span className="small">held in the hosted connector's OutLayer enclave </span>
                )}
                <span className="muted small">
                  {key.allowance ? `${formatNear(key.allowance)} NEAR of gas left` : "no gas limit"}
                </span>
                {signedInAsAgent && full && controls?.removeAgentKey && (
                  <button type="button" className="ghost" onClick={() => controls.removeAgentKey?.(key.publicKey)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {CONNECTOR_URL && hostedKey && forVault.some((key) => key.publicKey === hostedKey) && (
        <details>
          <summary>Add this vault to an AI app</summary>
          <HostedConnect connector={CONNECTOR_URL} />
        </details>
      )}
      {controls &&
        (signedInAsAgent ? (
          <button type="button" className="primary" onClick={() => controls.addAgentKey?.()}>
            Create agent key
          </button>
        ) : (
          <p className="muted small">
            To add a key, connect the wallet of {vault.roles.agent}. An agent this dashboard created has no key a
            wallet holds, so its owner uses Replace agent instead.
          </p>
        ))}
    </section>
  );
}

function ReplaceAgent({ controls }: { controls: Controls }) {
  const [name, setName] = useState("agent2");
  if (controls.pendingAgent) {
    return (
      <div className="replace-agent">
        <button type="button" className="primary" onClick={() => controls.switchAgent?.()}>
          Sign 2 of 2: switch the vault to {controls.pendingAgent}
        </button>
      </div>
    );
  }
  return (
    <div className="replace-agent">
      <input aria-label="New agent name" value={name} onChange={(event) => setName(event.target.value)} />
      <button type="button" onClick={() => controls.replaceAgent?.(name)}>
        Replace agent
      </button>
      <p className="muted small">
        Creates {name.trim() || "name"}.{controls.account} with a key for this vault only, then switches the vault
        to it. Use this if the agent's key leaks.
      </p>
    </div>
  );
}

function PowersCard({
  vault,
  provenance,
  controls,
}: {
  vault: VaultState;
  provenance?: Provenance | null;
  controls?: Controls;
}) {
  const role = controls?.role ?? "none";
  const dao = vault.guardianDao;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Who can do what</h2>
      </div>
      <ProvenanceLine provenance={provenance} />
      <dl className="powers">
        <dt>Agent</dt>
        <dd>
          <span className="mono">{vault.roles.agent}</span>
          <span className="muted small">
            Its key may call only propose_spend and execute.{" "}
            {vault.agentAllowance === null ? "" : `${formatNear(vault.agentAllowance)} NEAR of gas allowance left.`}
          </span>
        </dd>
        <dt>Guardian</dt>
        <dd>
          <span className="mono">{vault.roles.guardian ?? "None"}</span>
          <span className="muted small">
            {dao
              ? `A Sputnik DAO: its ${dao.council.length}-member council votes to veto or freeze.`
              : "Can veto and freeze."}
          </span>
        </dd>
        <dt>Owner</dt>
        <dd>
          <span className="mono">{vault.roles.owner}</span>
          <span className="muted small">Sets policy, vetoes, freezes and unfreezes.</span>
        </dd>
        <dt>Vault</dt>
        <dd>
          <span className="muted small">
            {vault.nearBalance === null ? "NEAR balance unavailable." : `${formatNear(vault.nearBalance)} NEAR for storage and signing fees.`}
          </span>
        </dd>
      </dl>
      {controls && (
        <div className="actions">
          {canStop(role) && !vault.frozen && (
            <button className="danger" onClick={() => controls.act("freeze", {})}>
              ❄ Freeze all chains
            </button>
          )}
          {role === "owner" && vault.frozen && (
            <button className="primary" onClick={() => controls.act("unfreeze", {})}>
              Unfreeze
            </button>
          )}
          {role === "owner" && controls.replaceAgent && <ReplaceAgent controls={controls} />}
          {controls.newAgent && (
            <ConnectAgent
              values={{ vault: controls.newAgent.vault, agent: controls.newAgent.agent, key: controls.newAgent.secret }}
              intro={`It belongs to ${controls.newAgent.agent}. Point your agent at it.`}
            />
          )}
          {role === "council" && (
            <p className="muted small">As a council member you propose and vote, so your wallet asks for two signatures.</p>
          )}
          {!controls.account && (
            <p className="muted small">Read-only. Connect the owner's or a guardian's wallet to veto or freeze.</p>
          )}
          {controls.message && (
            <p role="status" className="status-line">
              {controls.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Where to get test coins for this vault, with its addresses ready for Tidepool's faucet. */
function TestFunds({ vault }: { vault: VaultState }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <section className="card test-funds">
      <h2>Get test funds</h2>
      <p className="muted small">
        Everything here is testnet, so the coins are free. Tidepool sends its test USDC and USDT, the
        tokens this vault pays and swaps, once a week per address, on{" "}
        <a href={TIDEPOOL_FAUCET}>its faucet ↗</a>. Copy the vault's address for a chain, then paste it
        into one of the faucets below.
      </p>
      {faucetTargets(vault).map(({ chain, coins, address }) => (
        <div key={chain} className="faucet-buttons">
          <span className="muted small">
            {chain} ({coins}):
          </span>{" "}
          <span className="mono small">{address}</span>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(address);
              setCopied(chain);
            }}
          >
            {copied === chain ? "Copied" : `Copy the ${chain} address`}
          </button>
        </div>
      ))}
      <ul className="faucet-links">
        {FAUCET_LINKS.map((link) => (
          <li key={link.url}>
            <span className="muted">{link.coin}:</span> <a href={link.url}>{link.name} ↗</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Addresses({ accountId, vault }: { accountId: string; vault: VaultState }) {
  return (
    <footer className="footer">
      <div>
        <p className="label">Vault on Bitcoin testnet4</p>
        <a className="mono" href={explorerFor("Bitcoin", vault.btcAddress)}>
          {vault.btcAddress}
        </a>
      </div>
      <div>
        <p className="label">Vault on Base Sepolia</p>
        <a className="mono" href={explorerFor("Evm", vault.evmAddress)}>
          {vault.evmAddress}
        </a>
      </div>
      {vault.solAddress && (
        <div>
          <p className="label">Vault on Solana devnet</p>
          <a className="mono" href={explorerFor("Solana", vault.solAddress)}>
            {vault.solAddress}
          </a>
        </div>
      )}
      <div>
        <p className="label">{vault.solAddress ? "All three addresses are" : "Both addresses are"} derived from</p>
        <span className="mono">{accountId}</span> <span className="muted">via NEAR Chain Signatures</span>
      </div>
      <div>
        <a href={REPO_URL}>Source and security tests ↗</a>
      </div>
    </footer>
  );
}

export function Dashboard({
  accountId,
  status,
  controls,
  provenance,
}: {
  accountId: string;
  status: VaultStatus;
  controls?: Controls;
  provenance?: Provenance | null;
}) {
  const now = useNow();
  const vault = status.kind === "ready" ? status.vault : null;
  return (
    <>
      <TopBar accountId={accountId} vault={vault} controls={controls} />
      <main>
        {status.kind === "loading" && <p className="loading">Reading {accountId}…</p>}
        {status.kind === "error" && (
          <p className="banner banner-frozen" role="alert">
            Couldn't read {accountId}. Is it a Covenant vault? {status.message}
          </p>
        )}
        {vault && (
          <Ready accountId={accountId} vault={vault} now={now} controls={controls} provenance={provenance} />
        )}
      </main>
    </>
  );
}

function Ready({
  accountId,
  vault,
  now,
  controls,
  provenance,
}: {
  accountId: string;
  vault: VaultState;
  now: number;
  controls?: Controls;
  provenance?: Provenance | null;
}) {
  const rules = rulesOf(vault.policy);
  const latest = featured(vault.activity);
  return (
    <>
      <FrozenBanner vault={vault} activity={vault.activity} />
      <div className="hero">
        <Hero vault={vault} />
        <VerdictCard entry={latest} policy={vault.policy} rules={rules} now={now} />
      </div>
      <Flow entry={latest} />
      <Warnings vault={vault} />
      <div className="grid">
        <Feed activity={vault.activity} policy={vault.policy} rules={rules} now={now} />
        <aside className="side">
          <QueueCard queue={vault.queue} policy={vault.policy} now={now} controls={controls} />
          <BudgetCard balances={vault.balances} policy={vault.policy} />
          <RulesCard policy={vault.policy} rules={rules} controls={controls} />
          <PowersCard vault={vault} provenance={provenance} controls={controls} />
          <AgentKeysCard vault={vault} {...(controls ? { controls } : {})} />
          <TestFunds vault={vault} />
        </aside>
      </div>
      <Addresses accountId={accountId} vault={vault} />
    </>
  );
}

export function App() {
  const [status, setStatus] = useState<VaultStatus>({ kind: "loading" });
  const [account, setAccount] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState<{ vault: string; agent: string; secret: string } | null>(null);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const { accountId, rpcUrl } = config;

  useEffect(() => {
    let current = true;
    void connectedAccount(rpcUrl).then((connected) => {
      if (current) setAccount(connected);
    });
    void walletConnector(rpcUrl).then((connector) => {
      connector.on("wallet:signIn", ({ accounts }) => setAccount(accounts[0]?.accountId ?? null));
      connector.on("wallet:signOut", () => setAccount(null));
    });
    return () => {
      current = false;
    };
  }, [rpcUrl]);

  // Once per page: what it checks can't change while the page is open, in any way that matters.
  useEffect(() => {
    let current = true;
    void loadProvenance(config, undefined, rpcFetch)
      .then((found) => {
        if (current) setProvenance(found);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (creating || reading) return;
    let current = true;
    let loading = false;
    const refresh = () => {
      // A slow service mustn't stack up requests behind the timer.
      if (loading) return;
      loading = true;
      loadVault(config, rpcFetch)
        .then((vault) => {
          if (current) setStatus({ kind: "ready", vault });
        })
        .catch((error: unknown) => {
          // A failed refresh keeps the last good view on screen.
          if (current) {
            setStatus((last) =>
              last.kind === "ready" ? last : { kind: "error", message: String(error) },
            );
          }
        })
        .finally(() => {
          loading = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);

  const vault = status.kind === "ready" ? status.vault : null;
  const role = vault ? roleOf(account, vault) : "none";
  const act = useCallback(
    (method: string, args: object) => {
      if (!vault) return;
      setMessage(`Waiting for your wallet to sign ${method}…`);
      runAction({
        rpcUrl,
        role,
        account: account ?? "",
        vault: accountId,
        state: vault,
        method,
        args,
        findProposal: (dao, from, proposer, description) =>
          findProposal(config, dao, from, proposer, description, rpcFetch),
      })
        .then(() => setMessage(`${method} sent. The page updates within a few seconds.`))
        .catch((error: unknown) => setMessage(`${method} failed: ${String(error)}`));
    },
    [account, accountId, role, rpcUrl, vault],
  );
  const replaceAgent = useCallback(
    (name: string) => {
      if (!account) return;
      void (async () => {
        try {
          const agent = agentAccountId(name, account);
          // Only this wallet can create accounts under its own name, so an existing one is from an
          // earlier try whose second signature didn't happen.
          if (await accountExists(rpcUrl, agent)) {
            setPendingAgent(agent);
            setMessage(`${agent} already exists. Use the key you saved when it was made, and sign below to switch to it.`);
            return;
          }
          const key = newAgentKey();
          setMessage(`Sign 1 of 2: create ${agent}…`);
          await send(rpcUrl, createAgentTransaction(agent, accountId, key.publicKey));
          setNewAgent({ vault: accountId, agent, secret: key.secretKey });
          setPendingAgent(agent);
          setMessage(`Created ${agent}. Save its key below, then press "Sign 2 of 2".`);
        } catch (error) {
          setMessage(`Replacing the agent failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    },
    [account, accountId, rpcUrl],
  );
  const switchAgent = useCallback(() => {
    if (!pendingAgent) return;
    const agent = pendingAgent;
    setMessage(`Sign 2 of 2: point the vault at ${agent}…`);
    send(rpcUrl, vaultCall(accountId, "set_agent", { agent }))
      .then(() => {
        setPendingAgent(null);
        setMessage(`The vault's agent is now ${agent}. The page updates within a few seconds.`);
      })
      .catch((error: unknown) =>
        setMessage(`Switching the agent failed: ${error instanceof Error ? error.message : String(error)}. Press the button to try again.`),
      );
  }, [accountId, pendingAgent, rpcUrl]);
  const addAgentKey = useCallback(() => {
    if (!account) return;
    void (async () => {
      try {
        const key = newAgentKey();
        setMessage(`Waiting for your wallet to add a key to ${account}…`);
        await send(rpcUrl, addAgentKeyTransaction(account, accountId, key.publicKey));
        setNewAgent({ vault: accountId, agent: account, secret: key.secretKey });
        setMessage(`Added a key that can only ask ${accountId} for payments. Save it below.`);
      } catch (error) {
        setMessage(`Adding the key failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [account, accountId, rpcUrl]);
  const removeAgentKey = useCallback(
    (publicKey: string) => {
      if (!account) return;
      setMessage(`Waiting for your wallet to remove ${publicKey.slice(0, 20)}…`);
      send(rpcUrl, removeAgentKeyTransaction(account, publicKey))
        .then(() => setMessage("Key removed. The page updates within a few seconds."))
        .catch((error: unknown) => setMessage(`Removing the key failed: ${String(error)}`));
    },
    [account, rpcUrl],
  );
  const controls: Controls = {
    account,
    role,
    message,
    replaceAgent,
    switchAgent,
    pendingAgent,
    newAgent,
    addAgentKey,
    removeAgentKey,
    connect: () => {
      void walletConnector(rpcUrl)
        .then((connector) => connector.connect())
        .catch((error: unknown) => setMessage(`Couldn't connect: ${String(error)}`));
    },
    disconnect: () => {
      void walletConnector(rpcUrl).then((connector) => connector.disconnect());
    },
    act,
  };

  if (reading) {
    return (
      <>
        <TopBar vault={null} controls={controls} />
        <main>
          <Docs />
        </main>
      </>
    );
  }
  if (connectRequest) {
    return (
      <>
        <TopBar vault={null} controls={controls} />
        <main>
          <ConnectClaude
            config={config}
            fetcher={rpcFetch}
            account={account}
            connect={controls.connect}
            request={connectRequest}
            connector={connectorParam}
          />
        </main>
      </>
    );
  }
  if (creating) {
    return (
      <>
        <TopBar vault={null} controls={controls} />
        <main>
          <CreateVault config={config} fetcher={rpcFetch} account={account} connect={controls.connect} />
        </main>
      </>
    );
  }
  return <Dashboard accountId={accountId} status={status} controls={controls} provenance={provenance} />;
}

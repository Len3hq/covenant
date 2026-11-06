import { useCallback, useEffect, useState } from "react";
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
  payeeAddress,
  secondsUntil,
  vetoDelaySeconds,
  warnings,
  withRpcFallback,
  type Activity,
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
  walletConnector,
  type Role,
} from "./wallet";

const REFRESH_MS = 5_000;
const REPO_URL = "https://github.com/Len3hq/covenant";
const SIGNER = "v1.signer-prod.testnet";
const rpcFetch = withRpcFallback(defaultConfig.rpcUrl);

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

function TopBar({
  accountId,
  vault,
  controls,
}: {
  accountId: string;
  vault: VaultState | null;
  controls?: Controls;
}) {
  return (
    <header className="topbar">
      <a className="brand" href={REPO_URL}>
        <Mark />
        <span>Covenant</span>
      </a>
      <span className="chip mono">{accountId}</span>
      <span className="chip">NEAR testnet</span>
      {vault && (
        <span className={`pill ${vault.frozen ? "pill-frozen" : "pill-live"}`}>
          <span className="dot" />
          {vault.frozen ? "Frozen" : "Enforcing"}
        </span>
      )}
      <span className="spacer" />
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
      {controls?.role === "owner" && <PolicyEditor policy={policy} controls={controls} />}
    </section>
  );
}

function PolicyEditor({ policy, controls }: { policy: Policy; controls: Controls }) {
  const [text, setText] = useState(() => JSON.stringify(policy, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <details>
      <summary>Edit policy</summary>
      <p className="muted small">The contract checks every rule again, and refuses anything it doesn't accept.</p>
      <textarea aria-label="Policy JSON" rows={16} value={text} onChange={(event) => setText(event.target.value)} />
      <button
        className="primary"
        onClick={() => {
          try {
            controls.act("set_policy", { policy: parsePolicy(text) });
            setProblem(null);
          } catch (error) {
            setProblem(String(error));
          }
        }}
      >
        Save policy
      </button>
      {problem && <p role="alert">{problem}</p>}
    </details>
  );
}

function PowersCard({ vault, controls }: { vault: VaultState; controls?: Controls }) {
  const role = controls?.role ?? "none";
  const dao = vault.guardianDao;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Who can do what</h2>
      </div>
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

function Addresses({ vault }: { vault: VaultState }) {
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
      <div>
        <p className="label">Both addresses are derived from</p>
        <span className="mono">covenant.len3hq.testnet</span> <span className="muted">via NEAR Chain Signatures</span>
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
}: {
  accountId: string;
  status: VaultStatus;
  controls?: Controls;
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
            Couldn't read {accountId}: {status.message}
          </p>
        )}
        {vault && <Ready vault={vault} now={now} controls={controls} />}
      </main>
    </>
  );
}

function Ready({ vault, now, controls }: { vault: VaultState; now: number; controls?: Controls }) {
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
          <PowersCard vault={vault} controls={controls} />
        </aside>
      </div>
      <Addresses vault={vault} />
    </>
  );
}

export function App() {
  const [status, setStatus] = useState<VaultStatus>({ kind: "loading" });
  const [account, setAccount] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { accountId, rpcUrl } = defaultConfig;

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

  useEffect(() => {
    let current = true;
    let loading = false;
    const refresh = () => {
      // A slow service mustn't stack up requests behind the timer.
      if (loading) return;
      loading = true;
      loadVault(defaultConfig, rpcFetch)
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
          findProposal(defaultConfig, dao, from, proposer, description, rpcFetch),
      })
        .then(() => setMessage(`${method} sent. The page updates within a few seconds.`))
        .catch((error: unknown) => setMessage(`${method} failed: ${String(error)}`));
    },
    [account, accountId, role, rpcUrl, vault],
  );
  const controls: Controls = {
    account,
    role,
    message,
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

  return <Dashboard accountId={accountId} status={status} controls={controls} />;
}

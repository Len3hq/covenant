import { useCallback, useEffect, useState } from "react";
import {
  defaultConfig,
  describeActivity,
  describeAsset,
  describePayee,
  describePayment,
  isShownInLog,
  loadVault,
  secondsUntil,
  vetoDelaySeconds,
  type Activity,
  type Balance,
  type Pending,
  type Policy,
  type VaultState,
} from "./vault";
import {
  canStop,
  connectedAccount,
  parsePolicy,
  roleOf,
  send,
  transactionsFor,
  walletConnector,
  type Role,
} from "./wallet";

const REFRESH_MS = 5_000;

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

function ControlsBar({ controls, vault }: { controls: Controls; vault: VaultState }) {
  const { account, role, message } = controls;
  return (
    <section className="wide controls">
      {account ? (
        <p>
          Signed in as {account}: {roleLabel(role)}.{" "}
          <button onClick={controls.disconnect}>Sign out</button>
        </p>
      ) : (
        <p>
          Read-only. <button onClick={controls.connect}>Connect a NEAR wallet</button> to veto or
          freeze.
        </p>
      )}
      {canStop(role) && !vault.frozen && (
        <button className="danger" onClick={() => controls.act("freeze", {})}>
          Freeze all chains
        </button>
      )}
      {role === "owner" && vault.frozen && (
        <button onClick={() => controls.act("unfreeze", {})}>Unfreeze</button>
      )}
      {role === "council" && (
        <p>As a council member you propose and vote, so your wallet asks for two signatures.</p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function roleLabel(role: Role): string {
  switch (role) {
    case "owner":
      return "owner, so you can set policy, veto, freeze and unfreeze";
    case "guardian":
      return "guardian, so you can veto and freeze";
    case "council":
      return "guardian DAO council, so you can veto and freeze by vote";
    case "none":
      return "no role on this vault";
  }
}

function PolicyEditor({ policy, controls }: { policy: Policy; controls: Controls }) {
  const [text, setText] = useState(() => JSON.stringify(policy, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <details>
      <summary>Edit policy</summary>
      <p>The contract checks every rule again, and refuses anything it doesn't accept.</p>
      <textarea
        aria-label="Policy JSON"
        rows={16}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
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

function VaultPanel({ vault }: { vault: VaultState }) {
  return (
    <section>
      <h2>Vault</h2>
      <p className={vault.frozen ? "status frozen" : "status active"}>
        {vault.frozen ? "Frozen" : "Active"}
      </p>
      <dl>
        <dt>Bitcoin testnet4</dt>
        <dd>{vault.btcAddress}</dd>
        <dt>Base Sepolia</dt>
        <dd>{vault.evmAddress}</dd>
        <dt>Owner</dt>
        <dd>{vault.roles.owner}</dd>
        <dt>Guardian</dt>
        <dd>
          {vault.roles.guardian ?? "None"}
          {vault.guardianDao && " (Sputnik DAO)"}
        </dd>
      </dl>
    </section>
  );
}

function BalancesPanel({ balances }: { balances: Balance[] }) {
  return (
    <section className="wide">
      <h2>Balances</h2>
      <table>
        <thead>
          <tr>
            <th>Asset</th>
            <th>Balance</th>
            <th>Spent in 24 h</th>
            <th>Limit per 24 h</th>
            <th>Unit</th>
          </tr>
        </thead>
        <tbody>
          {balances.map(({ name, unit, balance, spent24h, per24h }) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{balance ?? "Unavailable"}</td>
              <td>{spent24h}</td>
              <td>{per24h}</td>
              <td>{unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PolicyPanel({ policy, controls }: { policy: Policy; controls?: Controls }) {
  return (
    <section className="wide">
      <h2>Policy</h2>
      <table>
        <thead>
          <tr>
            <th>Asset</th>
            <th>Per transaction</th>
            <th>Per 24 h</th>
            <th>Queue from</th>
            <th>Unit</th>
          </tr>
        </thead>
        <tbody>
          {policy.caps.map((cap) => {
            const { name, unit } = describeAsset(cap.asset);
            return (
              <tr key={name}>
                <td>{name}</td>
                <td>{cap.per_tx}</td>
                <td>{cap.per_24h}</td>
                <td>{cap.queue_at}</td>
                <td>{unit}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <dl>
        <dt>Payees</dt>
        <dd>
          {policy.payees.length === 0
            ? "None, so every payment is refused"
            : policy.payees.map((payee) => <div key={describePayee(payee)}>{describePayee(payee)}</div>)}
        </dd>
        <dt>Bitcoin fee rate cap</dt>
        <dd>{policy.btc_max_fee_rate} sat/vB</dd>
        <dt>Bitcoin inputs per spend</dt>
        <dd>{policy.btc_max_inputs}</dd>
        <dt>EVM gas cost cap</dt>
        <dd>{policy.evm_max_gas_cost} wei</dd>
        <dt>EVM chains</dt>
        <dd>{policy.evm_chain_ids.join(", ")}</dd>
        <dt>Veto delay</dt>
        <dd>{vetoDelaySeconds(policy)} s</dd>
      </dl>
      {controls?.role === "owner" && <PolicyEditor policy={policy} controls={controls} />}
    </section>
  );
}

function QueuePanel({
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
  return (
    <section className="wide">
      <h2>Queue</h2>
      {queue.length === 0 ? (
        <p>Nothing is waiting.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Spend</th>
              <th>Chain</th>
              <th>Payments</th>
              <th>Executable in</th>
              {canVeto && <th>Stop it</th>}
            </tr>
          </thead>
          <tbody>
            {queue.map((spend) => (
              <tr key={spend.id}>
                <td>{spend.id}</td>
                <td>{spend.chain}</td>
                <td>
                  {spend.payments.map((payment) => (
                    <div key={payment.to.join()}>{describePayment(payment, policy)}</div>
                  ))}
                </td>
                <td>{secondsUntil(spend.executable_at, now)} s</td>
                {canVeto && (
                  <td>
                    <button
                      className="danger"
                      onClick={() => controls?.act("veto", { id: spend.id })}
                    >
                      Veto
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>The owner or guardian can veto any of these until they execute.</p>
    </section>
  );
}

function ActivityPanel({ activity, policy }: { activity: Activity[] | null; policy: Policy }) {
  return (
    <section className="wide">
      <h2>Activity log</h2>
      {activity === null && <p>Unavailable: the transaction API couldn't be read.</p>}
      {activity?.length === 0 && <p>Nothing has happened yet.</p>}
      {activity && activity.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Outcome</th>
              <th>Chain</th>
              <th>Payments</th>
              <th>NEAR transaction</th>
            </tr>
          </thead>
          <tbody>
            {activity.filter(isShownInLog).map((entry, index) => {
              const { outcome, stopped, signed } = describeActivity(entry);
              const tone = stopped ? "stopped" : signed ? "signed" : undefined;
              return (
                <tr key={`${entry.txHash}-${index}`} className={tone}>
                  <td className="nowrap">
                    {new Date(entry.at).toISOString().slice(0, 19).replace("T", " ")}
                  </td>
                  <td>{outcome}</td>
                  <td className="nowrap">{entry.chain ?? ""}</td>
                  <td>
                    {entry.payments.map((payment) => (
                      <div key={payment.to.join()}>{describePayment(payment, policy)}</div>
                    ))}
                  </td>
                  <td>
                    <a href={`https://testnet.nearblocks.io/txns/${entry.txHash}`}>
                      {entry.txHash.slice(0, 8)}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
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
  return (
    <main>
      <header>
        <h1>Covenant</h1>
        {status.kind === "loading" && <p>Reading {accountId}…</p>}
        {status.kind === "error" && (
          <p role="alert">
            Couldn't read {accountId}: {status.message}
          </p>
        )}
        {status.kind === "ready" && <p>Connected to {accountId}.</p>}
      </header>
      <div className="panels">
        {status.kind === "ready" && controls && (
          <ControlsBar controls={controls} vault={status.vault} />
        )}
        {status.kind === "ready" && <VaultPanel vault={status.vault} />}
        {status.kind === "ready" && <BalancesPanel balances={status.vault.balances} />}
        {status.kind === "ready" && <PolicyPanel policy={status.vault.policy} controls={controls} />}
        {status.kind === "ready" && (
          <QueuePanel
            queue={status.vault.queue}
            policy={status.vault.policy}
            now={Date.now()}
            controls={controls}
          />
        )}
        {status.kind === "ready" && (
          <ActivityPanel activity={status.vault.activity} policy={status.vault.policy} />
        )}
      </div>
    </main>
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
      loadVault()
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
      send(rpcUrl, transactionsFor(role, accountId, vault, method, args))
        .then(() => setMessage(`${method} sent. The page updates within a few seconds.`))
        .catch((error: unknown) => setMessage(`${method} failed: ${String(error)}`));
    },
    [accountId, role, rpcUrl, vault],
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

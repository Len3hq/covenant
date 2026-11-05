import { useEffect, useState } from "react";
import {
  defaultConfig,
  describeActivity,
  describeAsset,
  describePayee,
  describePayment,
  loadVault,
  secondsUntil,
  vetoDelaySeconds,
  type Activity,
  type Balance,
  type Pending,
  type Policy,
  type VaultState,
} from "./vault";

const REFRESH_MS = 5_000;

export type VaultStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; vault: VaultState };

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

function PolicyPanel({ policy }: { policy: Policy }) {
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
    </section>
  );
}

function QueuePanel({ queue, policy, now }: { queue: Pending[]; policy: Policy; now: number }) {
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        The owner or guardian can stop any of these with <code>make veto ID=&lt;spend&gt;</code>.
      </p>
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
            {activity.map((entry, index) => {
              const { outcome, stopped } = describeActivity(entry);
              return (
                <tr key={`${entry.txHash}-${index}`} className={stopped ? "stopped" : undefined}>
                  <td>{new Date(entry.at).toISOString().slice(0, 19).replace("T", " ")}</td>
                  <td>{outcome}</td>
                  <td>{entry.chain ?? ""}</td>
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

export function Dashboard({ accountId, status }: { accountId: string; status: VaultStatus }) {
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
        {status.kind === "ready" && <p>Connected to {accountId}, read-only.</p>}
      </header>
      <div className="panels">
        {status.kind === "ready" && <VaultPanel vault={status.vault} />}
        {status.kind === "ready" && <BalancesPanel balances={status.vault.balances} />}
        {status.kind === "ready" && <PolicyPanel policy={status.vault.policy} />}
        {status.kind === "ready" && (
          <QueuePanel queue={status.vault.queue} policy={status.vault.policy} now={Date.now()} />
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

  useEffect(() => {
    let current = true;
    const refresh = () => {
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
        });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);

  return <Dashboard accountId={defaultConfig.accountId} status={status} />;
}

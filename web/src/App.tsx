import { useEffect, useState } from "react";
import {
  defaultConfig,
  describeAsset,
  describePayee,
  loadVault,
  vetoDelaySeconds,
  type Policy,
  type VaultState,
} from "./vault";

const upcoming = [
  { title: "Balances", detail: "BTC, ETH and USDC, with spend in the last 24 h against each cap." },
  { title: "Queue", detail: "Queued spends with a countdown and a veto action." },
  { title: "Activity log", detail: "Signed, rejected, queued and vetoed spends, newest first." },
];

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
        {status.kind === "ready" && <PolicyPanel policy={status.vault.policy} />}
        {upcoming.map(({ title, detail }) => (
          <section key={title}>
            <h2>{title}</h2>
            <p>{detail}</p>
          </section>
        ))}
      </div>
    </main>
  );
}

export function App() {
  const [status, setStatus] = useState<VaultStatus>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    loadVault()
      .then((vault) => {
        if (current) setStatus({ kind: "ready", vault });
      })
      .catch((error: unknown) => {
        if (current) setStatus({ kind: "error", message: String(error) });
      });
    return () => {
      current = false;
    };
  }, []);

  return <Dashboard accountId={defaultConfig.accountId} status={status} />;
}

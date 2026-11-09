import { useEffect, useState } from "react";
import { buildRequest, STARTING_FORM, type CapForm, type PayeeForm, type VaultForm } from "./create";
import { FACTORY_ID, vaultsOf, type VaultConfig } from "./vault";
import { createVaultCall, send } from "./wallet";

const POLL_MS = 3_000;
const POLL_TRIES = 20;

const openHref = (vault: string) => `?vault=${encodeURIComponent(vault)}`;

function Field({
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function CapFields({
  name,
  cap,
  onChange,
}: {
  name: string;
  cap: CapForm;
  onChange(cap: CapForm): void;
}) {
  return (
    <fieldset className="caps">
      <legend>{name}</legend>
      <Field label="Most per payment" value={cap.perTx} onChange={(perTx) => onChange({ ...cap, perTx })} />
      <Field label="Most per 24 hours" value={cap.per24h} onChange={(per24h) => onChange({ ...cap, per24h })} />
      <Field
        label="Hold for veto from"
        value={cap.queueAt}
        onChange={(queueAt) => onChange({ ...cap, queueAt })}
      />
    </fieldset>
  );
}

function Payees({ payees, onChange }: { payees: PayeeForm[]; onChange(payees: PayeeForm[]): void }) {
  const update = (index: number, patch: Partial<PayeeForm>) =>
    onChange(payees.map((payee, i) => (i === index ? { ...payee, ...patch } : payee)));
  return (
    <fieldset className="payee-list">
      <legend>Who it may pay</legend>
      <p className="muted small">Everything else is refused. Bitcoin payees must be tb1q addresses.</p>
      {payees.map((payee, index) => (
        <div className="payee-row" key={index}>
          <input
            aria-label="Payee name"
            placeholder="Name"
            value={payee.label}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <select
            aria-label="Payee chain"
            value={payee.chain}
            onChange={(event) => update(index, { chain: event.target.value as PayeeForm["chain"] })}
          >
            <option value="Bitcoin">Bitcoin</option>
            <option value="Evm">Base</option>
          </select>
          <input
            aria-label="Payee address"
            className="mono"
            placeholder={payee.chain === "Bitcoin" ? "tb1q…" : "0x…"}
            value={payee.address}
            onChange={(event) => update(index, { address: event.target.value })}
          />
          <button type="button" className="ghost" onClick={() => onChange(payees.filter((_, i) => i !== index))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost"
        onClick={() => onChange([...payees, { label: "", chain: "Bitcoin", address: "" }])}
      >
        Add a payee
      </button>
    </fieldset>
  );
}

function NextSteps({ vault, agent }: { vault: string; agent: string }) {
  return (
    <section className="card created">
      <h2>✓ {vault} is live</h2>
      <p>Three things left before your agent can pay:</p>
      <ol>
        <li>
          <a href={openHref(vault)}>Open its dashboard</a> to see its Bitcoin and Base addresses, then send
          testnet funds to them.
        </li>
        <li>
          Give your agent a key that can only ask this vault for payments. From a clone of the repo:
          <pre className="mono">{`VAULT_ACCOUNT_ID=${vault} AGENT_ACCOUNT_ID=${agent} make agent-key`}</pre>
        </li>
        <li>
          Point your agent at it with the same two settings in <code>.env</code>.
        </li>
      </ol>
    </section>
  );
}

export function CreateVault({
  config,
  fetcher,
  account,
  connect,
}: {
  config: VaultConfig;
  fetcher: typeof fetch;
  account: string | null;
  connect(): void;
}) {
  const [form, setForm] = useState<VaultForm>(STARTING_FORM);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ vault: string; agent: string } | null>(null);
  const [mine, setMine] = useState<string[]>([]);

  useEffect(() => {
    if (!account) return;
    let current = true;
    void vaultsOf(config, account, FACTORY_ID, fetcher)
      .then((found) => {
        if (current) setMine(found);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [account, config, fetcher, created]);

  const submit = async () => {
    if (!account) return;
    setProblem(null);
    setBusy(true);
    try {
      const { args, deposit } = buildRequest(form, FACTORY_ID, account);
      const vault = `${args.name}.${FACTORY_ID}`;
      await send(config.rpcUrl, createVaultCall(FACTORY_ID, args, deposit));
      // A failed creation refunds the deposit and looks like success to the wallet, so ask the factory.
      for (let tries = 0; tries < POLL_TRIES; tries++) {
        if ((await vaultsOf(config, account, FACTORY_ID, fetcher)).includes(vault)) {
          setCreated({ vault, agent: args.agent });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      setProblem(
        `${vault} wasn't created, so your deposit was refunded. The name may be taken. Try another.`,
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (created) return <NextSteps vault={created.vault} agent={created.agent} />;

  return (
    <div className="create">
      <section className="create-intro">
        <p className="eyebrow">Create a vault</p>
        <h1>Your agent's spending rules, enforced on-chain.</h1>
        <p className="lede">
          You'll own a separate NEAR contract with its own Bitcoin and Base addresses. It runs code nobody can
          change, including us, and we hold no keys or funds. Testnet only, and not audited.
        </p>
        {mine.length > 0 && (
          <div className="mine">
            <p className="label">Your vaults</p>
            {mine.map((vault) => (
              <a key={vault} className="mono" href={openHref(vault)}>
                {vault}
              </a>
            ))}
          </div>
        )}
      </section>
      <form
        className="card create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Vault name"
          value={form.name}
          placeholder="acme"
          hint={`Becomes ${form.name.trim() || "name"}.${FACTORY_ID}`}
          onChange={(name) => setForm({ ...form, name })}
        />
        <Field
          label="Your agent's NEAR account"
          value={form.agent}
          placeholder="my-agent.testnet"
          hint="It can only ask for payments. It must be separate from your own account."
          onChange={(agent) => setForm({ ...form, agent })}
        />
        <Field
          label="Guardian (optional)"
          value={form.guardian}
          placeholder="your-dao.sputnikv2.testnet"
          hint="An account or Sputnik DAO that can also veto and freeze."
          onChange={(guardian) => setForm({ ...form, guardian })}
        />
        <Payees payees={form.payees} onChange={(payees) => setForm({ ...form, payees })} />
        <div className="cap-grid">
          <CapFields name="BTC" cap={form.btc} onChange={(btc) => setForm({ ...form, btc })} />
          <CapFields name="USDC" cap={form.usdc} onChange={(usdc) => setForm({ ...form, usdc })} />
          <CapFields name="ETH" cap={form.eth} onChange={(eth) => setForm({ ...form, eth })} />
        </div>
        <Field
          label="Veto window, in seconds"
          value={form.vetoSeconds}
          hint="How long large payments wait, so you or your guardian can stop them."
          onChange={(vetoSeconds) => setForm({ ...form, vetoSeconds })}
        />
        <Field
          label="Deposit, in NEAR"
          value={form.deposit}
          hint="Minimum 1.1. It stays in your vault to pay for storage, apart from a 0.01 registry fee."
          onChange={(deposit) => setForm({ ...form, deposit })}
        />
        {problem && (
          <p className="banner banner-frozen" role="alert">
            {problem}
          </p>
        )}
        {account ? (
          <button className="primary" disabled={busy}>
            {busy ? "Creating…" : `Create vault as ${account}`}
          </button>
        ) : (
          <button type="button" className="primary" onClick={connect}>
            Connect a NEAR wallet to continue
          </button>
        )}
      </form>
    </div>
  );
}

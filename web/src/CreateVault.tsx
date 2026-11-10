import { useEffect, useState } from "react";
import { buildRequest, STARTING_FORM, type CapForm, type PayeeForm, type VaultForm } from "./create";
import { FACTORY_ID, vaultsOf, type VaultConfig } from "./vault";
import { accountExists, createAgentTransaction, newAgentKey, type AgentKey } from "./agent";
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
  open,
  onChange,
}: {
  name: string;
  cap: CapForm;
  open: boolean;
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
      {open && (
        <Field
          label="New payees, most per 24 hours"
          value={cap.unlisted24h}
          hint="0 means new payees can't be paid in this asset."
          onChange={(unlisted24h) => onChange({ ...cap, unlisted24h })}
        />
      )}
    </fieldset>
  );
}

function Payees({
  payees,
  open,
  onChange,
}: {
  payees: PayeeForm[];
  open: boolean;
  onChange(payees: PayeeForm[]): void;
}) {
  const update = (index: number, patch: Partial<PayeeForm>) =>
    onChange(payees.map((payee, i) => (i === index ? { ...payee, ...patch } : payee)));
  return (
    <fieldset className="payee-list">
      <legend>{open ? "Trusted payees (optional)" : "Who it may pay"}</legend>
      <p className="muted small">
        {open
          ? "These are paid without the new-payee wait. Anyone else can be paid too, but each payment waits out the new-payee window so you can veto it."
          : "Everything else is refused."}{" "}
        Bitcoin payees must be tb1q addresses. A Solana payee's USDC account is listed for you, and must
        already exist.
      </p>
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
            <option value="Solana">Solana</option>
          </select>
          <input
            aria-label="Payee address"
            className="mono"
            placeholder={payee.chain === "Bitcoin" ? "tb1q…" : payee.chain === "Solana" ? "Solana address" : "0x…"}
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

/** The agent's key, shown once. Nothing on this page stores it, so closing the page loses it. */
function AgentSecret({ vault, agent, secret }: { vault: string; agent: string; secret: string }) {
  const env = `VAULT_ACCOUNT_ID=${vault}\nAGENT_ACCOUNT_ID=${agent}\nAGENT_PRIVATE_KEY=${secret}`;
  return (
    <div className="agent-secret">
      <p>
        <strong>Save your agent's key now.</strong> It's shown only this once, and this page keeps no copy. It
        can only ask {vault} for payments, within the rules you set.
      </p>
      <pre className="mono">{env}</pre>
      <button type="button" onClick={() => void navigator.clipboard?.writeText(env)}>
        Copy
      </button>
    </div>
  );
}

function NextSteps({ vault, agent, secret }: { vault: string; agent: string; secret?: string }) {
  return (
    <section className="card created">
      <h2>✓ {vault} is live</h2>
      {secret && <AgentSecret vault={vault} agent={agent} secret={secret} />}
      <p>{secret ? "Then, before your agent can pay:" : "Three things left before your agent can pay:"}</p>
      <ol>
        <li>
          <a href={openHref(vault)}>Open its dashboard</a> to see its Bitcoin, Base and Solana addresses, and
          use its "Get test funds" panel to fill them.
        </li>
        {!secret && (
          <li>
            Give your agent a key that can only ask this vault for payments. From a clone of the repo:
            <pre className="mono">{`VAULT_ACCOUNT_ID=${vault} AGENT_ACCOUNT_ID=${agent} make agent-key`}</pre>
          </li>
        )}
        <li>
          For Solana, create a durable nonce account the vault controls. It lets a payment held for a veto
          still land afterwards:
          <pre className="mono">{`VAULT_ACCOUNT_ID=${vault} make sol-nonce`}</pre>
        </li>
        <li>
          Point your agent at it with the same settings in <code>.env</code>.
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
  const [created, setCreated] = useState<{ vault: string; agent: string; secret?: string } | null>(null);
  // An agent account made in this visit, so a retry after a failed vault doesn't create it again.
  const [madeAgent, setMadeAgent] = useState<{ agent: string; vault: string; key: AgentKey } | null>(null);
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
      if (await accountExists(config.rpcUrl, vault, fetcher)) throw new Error(`${vault} is taken. Pick another name.`);
      let key: AgentKey | undefined;
      if (form.agentMode === "create") {
        if (madeAgent?.agent === args.agent && madeAgent.vault === vault) {
          key = madeAgent.key;
        } else {
          if (await accountExists(config.rpcUrl, args.agent, fetcher)) {
            throw new Error(`${args.agent} already exists. Pick another agent name, or use it as an existing account.`);
          }
          key = newAgentKey();
          await send(config.rpcUrl, createAgentTransaction(args.agent, vault, key.publicKey));
          setMadeAgent({ agent: args.agent, vault, key });
        }
      }
      await send(config.rpcUrl, createVaultCall(FACTORY_ID, args, deposit));
      // A failed creation refunds the deposit and looks like success to the wallet, so ask the factory.
      for (let tries = 0; tries < POLL_TRIES; tries++) {
        if ((await vaultsOf(config, account, FACTORY_ID, fetcher)).includes(vault)) {
          setCreated({ vault, agent: args.agent, ...(key ? { secret: key.secretKey } : {}) });
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

  if (created) return <NextSteps vault={created.vault} agent={created.agent} {...(created.secret ? { secret: created.secret } : {})} />;

  return (
    <div className="create">
      <section className="create-intro">
        <p className="eyebrow">Create a vault</p>
        <h1>Your agent's spending rules, enforced on-chain.</h1>
        <p className="lede">
          You'll own a separate NEAR contract with its own Bitcoin, Base and Solana addresses. It runs code nobody can
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
        <fieldset className="payee-mode">
          <legend>Your agent's NEAR account</legend>
          <label>
            <input
              type="radio"
              name="agent-mode"
              checked={form.agentMode === "create"}
              onChange={() => setForm({ ...form, agentMode: "create" })}
            />{" "}
            Create one for me
          </label>
          <label>
            <input
              type="radio"
              name="agent-mode"
              checked={form.agentMode === "existing"}
              onChange={() => setForm({ ...form, agentMode: "existing" })}
            />{" "}
            Use one I already have
          </label>
        </fieldset>
        {form.agentMode === "create" ? (
          <Field
            label="Agent name"
            value={form.agentName}
            placeholder="agent"
            hint={`Becomes ${form.agentName.trim() || "agent"}.${account ?? "your-account.testnet"}, funded with 0.5 NEAR for gas, with a key that can only ask this vault for payments. Your wallet signs it, then the vault.`}
            onChange={(agentName) => setForm({ ...form, agentName })}
          />
        ) : (
          <Field
            label="Agent account"
            value={form.agent}
            placeholder="my-agent.testnet"
            hint="It can only ask for payments. It must be separate from your own account. You add its key afterwards."
            onChange={(agent) => setForm({ ...form, agent })}
          />
        )}
        <Field
          label="Guardian (optional)"
          value={form.guardian}
          placeholder="your-dao.sputnikv2.testnet"
          hint="An account or Sputnik DAO that can also veto and freeze."
          onChange={(guardian) => setForm({ ...form, guardian })}
        />
        <fieldset className="payee-mode">
          <legend>Who the agent can pay</legend>
          <label>
            <input
              type="radio"
              name="payee-mode"
              checked={form.openPayees}
              onChange={() => setForm({ ...form, openPayees: true })}
            />{" "}
            Anyone, but hold payments to new payees so I can veto them
          </label>
          <label>
            <input
              type="radio"
              name="payee-mode"
              checked={!form.openPayees}
              onChange={() => setForm({ ...form, openPayees: false })}
            />{" "}
            Only the payees I list
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.allowSwaps}
              onChange={(event) => setForm({ ...form, allowSwaps: event.target.checked })}
            />{" "}
            Also pay on other chains and in other tokens, through Tidepool
          </label>
        </fieldset>
        <Payees
          payees={form.payees}
          open={form.openPayees}
          onChange={(payees) => setForm({ ...form, payees })}
        />
        <div className="cap-grid">
          <CapFields name="BTC" cap={form.btc} open={form.openPayees} onChange={(btc) => setForm({ ...form, btc })} />
          <CapFields name="USDC" cap={form.usdc} open={form.openPayees} onChange={(usdc) => setForm({ ...form, usdc })} />
          <CapFields name="ETH" cap={form.eth} open={form.openPayees} onChange={(eth) => setForm({ ...form, eth })} />
          <CapFields name="SOL" cap={form.sol} open={form.openPayees} onChange={(sol) => setForm({ ...form, sol })} />
          <CapFields
            name="USDC on Solana"
            cap={form.solUsdc}
            open={form.openPayees}
            onChange={(solUsdc) => setForm({ ...form, solUsdc })}
          />
        </div>
        <Field
          label="Veto window, in seconds"
          value={form.vetoSeconds}
          hint="How long large payments wait, so you or your guardian can stop them."
          onChange={(vetoSeconds) => setForm({ ...form, vetoSeconds })}
        />
        {form.openPayees && (
          <Field
            label="New-payee window, in seconds"
            value={form.unlistedSeconds}
            hint="How long every payment to someone off your list waits. At least the veto window; 48 hours suits real money."
            onChange={(unlistedSeconds) => setForm({ ...form, unlistedSeconds })}
          />
        )}
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

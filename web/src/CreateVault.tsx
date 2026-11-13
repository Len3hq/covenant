import { useEffect, useState } from "react";
import { buildPolicy, buildRequest, parseUnits, payeesFrom, STARTING_FORM, type VaultForm } from "./create";
import { ChoiceCard, Explainer, Stepper } from "./ui";
import { CapFields, Field, Payees } from "./PolicyFields";
import { FACTORY_ID, vaultsOf, type VaultConfig } from "./vault";
import { accountExists, createAgentTransaction, newAgentKey, type AgentKey } from "./agent";
import { ConnectAgent } from "./ConnectAgent";
import { createVaultCall, send } from "./wallet";
import { CONNECTOR_URL, hostedPublicKey } from "./hosted";
import { HostedConnect } from "./HostedConnect";

const POLL_MS = 3_000;
const POLL_TRIES = 20;

const openHref = (vault: string) => `?vault=${encodeURIComponent(vault)}`;

/** After a hosted vault: no key to save, only the connector to add to Claude. */
function HostedNextSteps({ vault, connector }: { vault: string; connector: string }) {
  return (
    <section className="card created">
      <h2>✓ {vault} is live</h2>
      <p>Its agent's key was made in an OutLayer enclave and never left it, so there's nothing to save.</p>
      <ol>
        <li>
          Add this vault's connector to your AI app, such as Claude, ChatGPT, Claude Code, Cursor or VS Code. Each
          hosted vault has its own address, so you can add several:
          <HostedConnect connector={connector} vault={vault} />
        </li>
        <li>
          <a href={openHref(vault)}>Open its dashboard</a> to fund it from the "Get test funds" panel.
        </li>
      </ol>
    </section>
  );
}

function NextSteps({ vault, agent, secret }: { vault: string; agent: string; secret?: string }) {
  return (
    <section className="card created">
      <h2>✓ {vault} is live</h2>
      {secret && <ConnectAgent values={{ vault, agent, key: secret }} />}
      <p>{secret ? "Then, before your agent can pay:" : "Two things left before your agent can pay:"}</p>
      <ol>
        {!secret && (
          <li>
            Give your agent a key that can only ask this vault for payments: on the vault's page, connect {agent}'s
            wallet and press <strong>Create agent key</strong>. The page then shows the config to paste into your AI
            app.
          </li>
        )}
        <li>
          <a href={openHref(vault)}>Open its dashboard</a> to see its Bitcoin, Base and Solana addresses, and use its "Get
          test funds" panel to fill them.
        </li>
      </ol>
      <p className="muted small">
        Only for Solana payments: the vault needs a durable nonce account, so a payment held for a veto can still land
        afterwards. Create one from a terminal:
      </p>
      <pre className="mono">{`VAULT_ACCOUNT_ID=${vault} npx -y @len3hq/covenant-mcp@latest sol-nonce`}</pre>
      <p className="muted small">
        The first run asks you to send a little devnet SOL to a funder address it makes, then to run it again. Then add
        the <code>SOL_NONCE_ACCOUNTS</code> it prints to the <code>env</code> of your app's Covenant config.
      </p>
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
  const [created, setCreated] = useState<{ vault: string; agent: string; secret?: string; hosted?: boolean } | null>(null);
  // An agent account made in this visit, so a retry after a failed vault doesn't create it again.
  const [madeAgent, setMadeAgent] = useState<{ agent: string; vault: string; key: AgentKey } | null>(null);
  /** The agent's key lives in the hosted connector's enclave, so this page never holds a secret. */
  const [hosted, setHosted] = useState(false);
  const [mine, setMine] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [limits, setLimits] = useState<"starter" | "standard" | "custom">("starter");
  /** Whether the typed name is taken: null while unknown. */
  const [taken, setTaken] = useState<boolean | null>(null);

  useEffect(() => {
    const name = form.name.trim();
    setTaken(null);
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(name)) return;
    let current = true;
    const timer = setTimeout(() => {
      void accountExists(config.rpcUrl, `${name}.${FACTORY_ID}`, fetcher).then((exists) => {
        if (current) setTaken(exists);
      });
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [form.name, config.rpcUrl, fetcher]);

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
      const { args, deposit } = buildRequest(
        { ...form, payees: form.payees.filter((p) => p.label.trim() || p.address.trim()) },
        FACTORY_ID,
        account,
      );
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
          key =
            hosted && CONNECTOR_URL
              ? { publicKey: await hostedPublicKey(CONNECTOR_URL, fetcher), secretKey: "" }
              : newAgentKey();
          await send(config.rpcUrl, createAgentTransaction(args.agent, vault, key.publicKey));
          setMadeAgent({ agent: args.agent, vault, key });
          // The vault takes a second click: browsers block a wallet pop-up that opens long after one.
          return;
        }
      }
      await send(config.rpcUrl, createVaultCall(FACTORY_ID, args, deposit));
      // A failed creation refunds the deposit and looks like success to the wallet, so ask the factory.
      for (let tries = 0; tries < POLL_TRIES; tries++) {
        if ((await vaultsOf(config, account, FACTORY_ID, fetcher)).includes(vault)) {
          setCreated({ vault, agent: args.agent, ...(key?.secretKey ? { secret: key.secretKey } : {}), hosted: Boolean(key && !key.secretKey) });
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

  if (created?.hosted && CONNECTOR_URL) return <HostedNextSteps vault={created.vault} connector={CONNECTOR_URL} />;
  if (created) return <NextSteps vault={created.vault} agent={created.agent} {...(created.secret ? { secret: created.secret } : {})} />;

  const agentChoice: AgentChoice = form.agentMode === "existing" ? "existing" : hosted ? "hosted" : "self";
  const chooseAgent = (choice: AgentChoice) => {
    setHosted(choice === "hosted");
    setForm({ ...form, agentMode: choice === "existing" ? "existing" : "create" });
  };
  const filled = { ...form, payees: form.payees.filter((p) => p.label.trim() || p.address.trim()) };
  const next = () => {
    try {
      checkStep(step, filled, account ?? "you.testnet", taken);
      setProblem(null);
      setStep(step + 1);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const vaultId = `${form.name.trim() || "name"}.${FACTORY_ID}`;
  const agentId =
    form.agentMode === "existing" ? form.agent.trim() || "your agent account" : `${form.agentName.trim() || "agent"}.${account ?? "your-account.testnet"}`;

  return (
    <div className="page create-page">
      <div className="page-head">
        <div>
          <h1>Create a vault</h1>
          <p className="muted">
            Your agent's money, with your rules enforced on-chain. You'll own a NEAR contract with its own Bitcoin, Base
            and Solana addresses, running code nobody can change, including us.
          </p>
        </div>
        {mine.length > 0 && (
          <a className="button ghost" href="?mine">
            My vaults ({mine.length})
          </a>
        )}
      </div>
      <Stepper steps={STEPS} current={step} onPick={(index) => setStep(index)} />
      <form
        className="card wizard"
        onSubmit={(event) => {
          event.preventDefault();
          if (step < STEPS.length - 1) next();
          else void submit();
        }}
      >
        {step === 0 && (
          <>
            <h2>Name your vault</h2>
            <p className="muted small">The name becomes the vault's NEAR account. Lowercase letters, digits, - and _.</p>
            <Field label="Vault name" value={form.name} placeholder="acme" onChange={(name) => setForm({ ...form, name })} />
            <p className={`availability ${taken === true ? "bad" : taken === false ? "good" : ""}`}>
              <span className="mono">{vaultId}</span>{" "}
              {taken === true ? "✕ is taken" : taken === false ? "✓ is available" : form.name.trim() ? "checking…" : ""}
            </p>
            <Field
              label="Deposit, in NEAR"
              value={form.deposit}
              hint="At least 1.1. It stays in the vault to pay for its storage and signing fees, apart from a 0.01 registry fee."
              onChange={(deposit) => setForm({ ...form, deposit })}
            />
          </>
        )}

        {step === 1 && (
          <>
            <h2>How will your agent run?</h2>
            <p className="muted small">
              The agent is a NEAR account whose key can only ask this vault for payments. It can't move funds or change
              rules on its own.
            </p>
            <div className="choice-grid">
              <ChoiceCard name="agent" checked={agentChoice === "self"} onSelect={() => chooseAgent("self")} title="I'll run it" badge="Most private">
                We create the agent account and give you its key once. Use it with Claude Desktop, Claude Code, Cursor or
                your own code.
              </ChoiceCard>
              {CONNECTOR_URL && (
                <ChoiceCard name="agent" checked={agentChoice === "hosted"} onSelect={() => chooseAgent("hosted")} title="Hosted" badge="Web & phone">
                  The key is made and kept in an OutLayer enclave nobody can read, including us. Add the vault to Claude,
                  ChatGPT or any AI app by URL.
                </ChoiceCard>
              )}
              <ChoiceCard name="agent" checked={agentChoice === "existing"} onSelect={() => chooseAgent("existing")} title="An account I have">
                Use a NEAR account you already control as the agent. You add its vault key afterwards from the vault page.
              </ChoiceCard>
            </div>
            {agentChoice === "existing" ? (
              <Field
                label="Agent account"
                value={form.agent}
                placeholder="my-agent.testnet"
                hint="It must be separate from your own account."
                onChange={(agent) => setForm({ ...form, agent })}
              />
            ) : (
              <Field
                label="Agent name"
                value={form.agentName}
                placeholder="agent"
                hint={`Becomes ${agentId}, funded with 0.5 NEAR for gas.`}
                onChange={(agentName) => setForm({ ...form, agentName })}
              />
            )}
            <details className="disclosure">
              <summary>Add a guardian (optional)</summary>
              <Field
                label="Guardian"
                value={form.guardian}
                placeholder="your-dao.sputnikv2.testnet"
                hint="Another account, or a Sputnik DAO, that can also veto payments and freeze the vault. Only you can change rules or unfreeze."
                onChange={(guardian) => setForm({ ...form, guardian })}
              />
            </details>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Who can the agent pay?</h2>
            <div className="choice-grid">
              <ChoiceCard name="open" checked={form.openPayees} onSelect={() => setForm({ ...form, openPayees: true })} title="Anyone, with a wait" badge="Flexible">
                Payees you list are paid at once. Anyone else is paid only after a wait, so you can veto it.
              </ChoiceCard>
              <ChoiceCard name="open" checked={!form.openPayees} onSelect={() => setForm({ ...form, openPayees: false })} title="Only my payees" badge="Strictest">
                The vault refuses every address that isn't on your list.
              </ChoiceCard>
            </div>
            <Payees payees={form.payees} open={form.openPayees} onChange={(payees) => setForm({ ...form, payees })} />
            <label className="check">
              <input type="checkbox" checked={form.allowSwaps} onChange={(event) => setForm({ ...form, allowSwaps: event.target.checked })} />{" "}
              Also pay on other chains and in other tokens, through Tidepool's signed quotes
            </label>
          </>
        )}

        {step === 3 && (
          <>
            <h2>How much can it spend?</h2>
            <p className="muted small">Limits are per asset, in whole coins. Anything over a limit is refused.</p>
            <div className="choice-grid">
              {PRESETS.map((preset) => (
                <ChoiceCard
                  key={preset.id}
                  name="preset"
                  checked={limits === preset.id}
                  onSelect={() => {
                    setLimits(preset.id);
                    if (preset.form) setForm({ ...form, ...preset.form });
                  }}
                  title={preset.title}
                >
                  {preset.body}
                </ChoiceCard>
              ))}
            </div>
            {limits === "custom" ? (
              <div className="cap-grid">
                <CapFields name="BTC" cap={form.btc} open={form.openPayees} onChange={(btc) => setForm({ ...form, btc })} />
                <CapFields name="USDC on Base" cap={form.usdc} open={form.openPayees} onChange={(usdc) => setForm({ ...form, usdc })} />
                <CapFields name="ETH on Base" cap={form.eth} open={form.openPayees} onChange={(eth) => setForm({ ...form, eth })} />
                <CapFields name="SOL" cap={form.sol} open={form.openPayees} onChange={(sol) => setForm({ ...form, sol })} />
                <CapFields name="USDC on Solana" cap={form.solUsdc} open={form.openPayees} onChange={(solUsdc) => setForm({ ...form, solUsdc })} />
              </div>
            ) : (
              <LimitsTable form={form} />
            )}
            <div className="two-up">
              <Field
                label="Veto window, in seconds"
                value={form.vetoSeconds}
                hint={`${secondsHint(form.vetoSeconds)}. How long large payments wait, so you or your guardian can stop them.`}
                onChange={(vetoSeconds) => setForm({ ...form, vetoSeconds })}
              />
              {form.openPayees && (
                <Field
                  label="Wait for new addresses, in seconds"
                  value={form.unlistedSeconds}
                  hint={`${secondsHint(form.unlistedSeconds)}. Every payment to an address off your list waits this long. 48 hours suits real money.`}
                  onChange={(unlistedSeconds) => setForm({ ...form, unlistedSeconds })}
                />
              )}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h2>Review and create</h2>
            <dl className="review-list">
              <dt>Vault</dt>
              <dd className="mono">{vaultId}</dd>
              <dt>Owner</dt>
              <dd className="mono">{account ?? "your wallet"}</dd>
              <dt>Agent</dt>
              <dd>
                <span className="mono">{agentId}</span>{" "}
                <span className="muted small">
                  {agentChoice === "hosted" ? "key held in the enclave" : agentChoice === "self" ? "you get its key once" : "you add its key later"}
                </span>
              </dd>
              {form.guardian.trim() && (
                <>
                  <dt>Guardian</dt>
                  <dd className="mono">{form.guardian.trim()}</dd>
                </>
              )}
              <dt>Payees</dt>
              <dd>
                {filled.payees.length === 0 ? "None" : filled.payees.map((p) => p.label).join(", ")}
                <span className="muted small">
                  {form.openPayees ? `; others wait ${secondsHint(form.unlistedSeconds)}` : "; everyone else refused"}
                </span>
              </dd>
              <dt>Limits</dt>
              <dd>
                {form.btc.perTx} BTC, {form.usdc.perTx} USDC per payment <span className="muted small">(and more, as set)</span>
              </dd>
              <dt>Swaps</dt>
              <dd>{form.allowSwaps ? "On, through Tidepool" : "Off"}</dd>
              <dt>Cost</dt>
              <dd>
                {form.deposit} NEAR deposit{form.agentMode === "create" ? " + 0.5 NEAR for the agent's gas" : ""}{" "}
                <span className="muted small">(stays with the vault and agent)</span>
              </dd>
            </dl>
            <Explainer title={form.agentMode === "create" ? "Two signatures" : "One signature"}>
              {form.agentMode === "create"
                ? "Your wallet first creates the agent account, then the button changes to “Sign 2 of 2”, which creates the vault. Browsers block a second wallet window that opens on its own, so it waits for your click."
                : "Your wallet signs once, to create the vault."}
            </Explainer>
          </>
        )}

        {problem && (
          <p className="banner banner-frozen" role="alert">
            {problem}
          </p>
        )}
        <div className="wizard-nav">
          {step > 0 && (
            <button type="button" className="ghost" onClick={() => setStep(step - 1)}>
              ← Back
            </button>
          )}
          <span className="spacer" />
          {step < STEPS.length - 1 ? (
            <button className="primary">Continue →</button>
          ) : account ? (
            <button className="primary" disabled={busy}>
              {busy ? "Waiting for your wallet…" : madeAgent ? `Sign 2 of 2: create the vault` : "Create vault"}
            </button>
          ) : (
            <button type="button" className="primary" onClick={connect}>
              Connect a NEAR wallet to create it
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

type AgentChoice = "self" | "hosted" | "existing";
const STEPS = ["Name", "Agent", "Payments", "Limits", "Review"];

const PRESETS: { id: "starter" | "standard" | "custom"; title: string; body: string; form?: Partial<VaultForm> }[] = [
  {
    id: "starter",
    title: "Starter",
    body: "Small amounts, good for trying it out: 0.005 BTC or 50 USDC a payment.",
    form: { btc: STARTING_FORM.btc, eth: STARTING_FORM.eth, usdc: STARTING_FORM.usdc, sol: STARTING_FORM.sol, solUsdc: STARTING_FORM.solUsdc },
  },
  {
    id: "standard",
    title: "Standard",
    body: "Room for real bills: 0.02 BTC or 200 USDC a payment.",
    form: {
      btc: { perTx: "0.02", per24h: "0.08", queueAt: "0.01", unlisted24h: "0.02" },
      eth: { perTx: "0.05", per24h: "0.2", queueAt: "0.025", unlisted24h: "0.05" },
      usdc: { perTx: "200", per24h: "800", queueAt: "100", unlisted24h: "150" },
      sol: { perTx: "0.5", per24h: "2", queueAt: "0.25", unlisted24h: "0.5" },
      solUsdc: { perTx: "200", per24h: "800", queueAt: "100", unlisted24h: "150" },
    },
  },
  { id: "custom", title: "Custom", body: "Set every limit yourself." },
];

/** The limits a preset sets, read-only. */
function LimitsTable({ form }: { form: VaultForm }) {
  const rows: [string, VaultForm["btc"]][] = [
    ["BTC", form.btc],
    ["ETH on Base", form.eth],
    ["USDC on Base", form.usdc],
    ["SOL", form.sol],
    ["USDC on Solana", form.solUsdc],
  ];
  return (
    <table className="limits-table">
      <thead>
        <tr>
          <th>Asset</th>
          <th>Per payment</th>
          <th>Per 24 h</th>
          <th>Held for veto from</th>
          {form.openPayees && <th>New addresses per 24 h</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, cap]) => (
          <tr key={name}>
            <td>{name}</td>
            <td>{cap.perTx}</td>
            <td>{cap.per24h}</td>
            <td>{cap.queueAt}</td>
            {form.openPayees && <td>{cap.unlisted24h}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function secondsHint(text: string): string {
  const s = Number(text.trim());
  if (!Number.isFinite(s)) return "not a number";
  if (s < 60) return `${s} seconds`;
  if (s < 3600) return `${Number((s / 60).toFixed(1))} minutes`;
  return `${Number((s / 3600).toFixed(1))} hours`;
}

/** What must be right before leaving a step, checked with the same code the final request uses. */
export function checkStep(step: number, form: VaultForm, owner: string, taken: boolean | null) {
  if (step === 0) {
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(form.name.trim())) {
      throw new Error("The vault name can use lowercase letters, digits, - and _, with no dots");
    }
    if (taken) throw new Error("That name is taken. Pick another.");
    parseUnits(form.deposit, 24);
  }
  if (step === 1) {
    buildRequest({ ...form, payees: [], openPayees: true }, FACTORY_ID, owner);
  }
  if (step === 2) {
    if (!form.openPayees && form.payees.length === 0) throw new Error("Add a payee, or choose “Anyone, with a wait”");
    payeesFrom(form.payees);
  }
  if (step === 3) buildPolicy(form);
}

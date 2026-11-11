import { useEffect, useState } from "react";
import { CONNECTOR_URL, grantExpiry, hostedPublicKey, signGrant, submitGrant } from "./hosted";
import { FACTORY_ID, vaultsOf, type VaultConfig } from "./vault";

interface Choice {
  vault: string;
  agent: string;
  hosted: boolean;
}

const DURATIONS = [7, 30, 90];

/**
 * Where Claude sends an owner to sign in to the hosted connector: pick a vault, and sign a grant
 * that lets the connector's enclave key ask that vault for payments until it expires.
 */
export function ConnectClaude({
  config,
  fetcher,
  account,
  connect,
  request,
  connector,
}: {
  config: VaultConfig;
  fetcher: typeof fetch;
  account: string | null;
  connect(): void;
  request: string;
  connector: string;
}) {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [days, setDays] = useState(30);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trusted = CONNECTOR_URL !== undefined && connector.replace(/\/$/, "") === CONNECTOR_URL;

  useEffect(() => {
    if (!account || !trusted || !CONNECTOR_URL) return;
    let current = true;
    void (async () => {
      try {
        const [hostedKey, vaults] = await Promise.all([
          hostedPublicKey(CONNECTOR_URL as string, fetcher),
          vaultsOf(config, account, FACTORY_ID, fetcher),
        ]);
        const found = await Promise.all(
          vaults.map(async (vault): Promise<Choice> => {
            const roles = await view<{ agent: string }>(config, vault, "get_roles", fetcher);
            return { vault, agent: roles.agent, hosted: await hasKey(config, roles.agent, hostedKey, vault, fetcher) };
          }),
        );
        if (!current) return;
        setChoices(found);
        setPicked(found.find((choice) => choice.hosted)?.vault ?? "");
      } catch (error) {
        if (current) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      current = false;
    };
  }, [account, config, fetcher, trusted]);

  const approve = async () => {
    const choice = choices?.find((c) => c.vault === picked);
    if (!account || !choice || !CONNECTOR_URL) return;
    setBusy(true);
    setProblem(null);
    try {
      const grant = await signGrant(config.rpcUrl, {
        owner: account,
        vault: choice.vault,
        agent: choice.agent,
        expires: grantExpiry(days),
      });
      window.location.assign(await submitGrant(CONNECTOR_URL, request, grant));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  if (!trusted) {
    return (
      <section className="card create">
        <h2>Unknown connector</h2>
        <p className="banner banner-frozen">
          This sign-in names {connector}, which isn't the Covenant connector this dashboard knows. Nothing was signed.
        </p>
      </section>
    );
  }
  const hostedChoices = choices?.filter((choice) => choice.hosted) ?? [];
  return (
    <section className="card create">
      <h2>Connect Claude to your vault</h2>
      <p className="muted small">
        Claude will be able to ask one vault for payments, through an agent key held in an OutLayer enclave that nobody can
        read. The vault still applies all your rules, and you can stop it any time by replacing the agent or freezing the
        vault.
      </p>
      {!account ? (
        <button type="button" className="primary" onClick={connect}>
          Connect the vault owner's NEAR wallet
        </button>
      ) : choices === null ? (
        <p className="muted small">Finding your vaults…</p>
      ) : hostedChoices.length === 0 ? (
        <p className="muted small">
          None of {account}'s vaults has a hosted agent. Create one on <a href="?create">Create a vault</a> with "Hosted, for
          Claude on the web or phone" ticked, then connect again from Claude.
        </p>
      ) : (
        <>
          <fieldset className="payee-mode">
            <legend>Which vault</legend>
            {hostedChoices.map((choice) => (
              <label key={choice.vault}>
                <input
                  type="radio"
                  name="vault"
                  checked={picked === choice.vault}
                  onChange={() => setPicked(choice.vault)}
                />{" "}
                <span className="mono small">{choice.vault}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>For how long</span>
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" disabled={busy || !picked} onClick={() => void approve()}>
            {busy ? "Waiting for your wallet…" : "Sign and connect"}
          </button>
          <p className="muted small">Your wallet signs a message, not a transaction: it costs nothing and moves no funds.</p>
        </>
      )}
      {problem && (
        <p className="banner banner-frozen" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

async function query<T>(config: VaultConfig, params: object, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "q", method: "query", params: { finality: "final", ...params } }),
  });
  const body = (await response.json()) as { result?: T };
  if (!body.result) throw new Error("NEAR didn't answer");
  return body.result;
}

async function view<T>(config: VaultConfig, account: string, method: string, fetcher: typeof fetch): Promise<T> {
  const { result } = await query<{ result: number[] }>(
    config,
    { request_type: "call_function", account_id: account, method_name: method, args_base64: "" },
    fetcher,
  );
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result))) as T;
}

/** Whether the agent holds the enclave's key, scoped to this vault. */
async function hasKey(config: VaultConfig, agent: string, key: string, vault: string, fetcher: typeof fetch) {
  try {
    const found = await query<{ permission: { FunctionCall?: { receiver_id: string } } | string }>(
      config,
      { request_type: "view_access_key", account_id: agent, public_key: key },
      fetcher,
    );
    return typeof found.permission === "object" && found.permission.FunctionCall?.receiver_id === vault;
  } catch {
    return false;
  }
}

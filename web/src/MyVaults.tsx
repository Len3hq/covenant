import { useEffect, useState } from "react";
import { CONNECTOR_URL, hostedPublicKey } from "./hosted";
import { Explainer, Identicon, Skeleton } from "./ui";
import { FACTORY_ID, vaultsOf, type VaultConfig } from "./vault";

/** Factories that made vaults before the current one, which still answer `vaults_of`. */
export const OLDER_FACTORIES = ["vaults.len3hq.testnet"];

interface Owned {
  vault: string;
  agent: string | null;
  frozen: boolean | null;
  waiting: number | null;
  payees: number | null;
  hosted: boolean;
}

/** Every vault the connected wallet owns, from each factory's own record. */
export async function ownedVaults(
  config: VaultConfig,
  owner: string,
  fetcher: typeof fetch = fetch,
  factories: string[] = [FACTORY_ID, ...OLDER_FACTORIES],
): Promise<string[]> {
  const lists = await Promise.all(factories.map((factory) => vaultsOf(config, owner, factory, fetcher).catch(() => [])));
  return [...new Set(lists.flat())];
}

/**
 * Whether `account` holds `publicKey` as a key for `vault`. NEAR answers a missing key with an error
 * inside a normal result, so only a key whose permission names the vault counts.
 */
export async function hasVaultKey(
  config: VaultConfig,
  account: string,
  publicKey: string,
  vault: string,
  fetcher: typeof fetch,
): Promise<boolean> {
  const response = await fetcher(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "k",
      method: "query",
      params: { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey },
    }),
  });
  const { result } = (await response.json()) as {
    result?: { permission?: { FunctionCall?: { receiver_id?: string } } | string };
  };
  const permission = result?.permission;
  return typeof permission === "object" && permission.FunctionCall?.receiver_id === vault;
}

async function view<T>(config: VaultConfig, account: string, method: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "v",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: "" },
    }),
  });
  const { result } = (await response.json()) as { result?: { result?: number[] } };
  if (!result?.result) throw new Error(`${account} didn't answer ${method}`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
}

export function MyVaults({
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
  const [vaults, setVaults] = useState<Owned[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    let current = true;
    setVaults(null);
    void (async () => {
      try {
        const [names, hostedKey] = await Promise.all([
          ownedVaults(config, account, fetcher),
          CONNECTOR_URL ? hostedPublicKey(CONNECTOR_URL, fetcher).catch(() => null) : Promise.resolve(null),
        ]);
        const found = await Promise.all(
          names.map(async (vault): Promise<Owned> => {
            const [roles, frozen, queue, policy] = await Promise.all([
              view<{ agent: string }>(config, vault, "get_roles", fetcher).catch(() => null),
              view<boolean>(config, vault, "is_frozen", fetcher).catch(() => null),
              view<unknown[]>(config, vault, "get_queue", fetcher).catch(() => null),
              view<{ payees: unknown[] }>(config, vault, "get_policy", fetcher).catch(() => null),
            ]);
            const hosted = Boolean(roles && hostedKey && (await hasVaultKey(config, roles.agent, hostedKey, vault, fetcher).catch(() => false)));
            return {
              vault,
              agent: roles?.agent ?? null,
              frozen,
              waiting: queue?.length ?? null,
              payees: policy?.payees.length ?? null,
              hosted,
            };
          }),
        );
        if (current) setVaults(found);
      } catch (error) {
        if (current) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      current = false;
    };
  }, [account, config, fetcher]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>My vaults</h1>
          <p className="muted">{account ? `Every vault ${account} created.` : "Connect the wallet that created your vaults."}</p>
        </div>
        <a className="button primary" href="?create">
          + New vault
        </a>
      </div>
      {!account ? (
        <section className="card empty-state">
          <h2>Connect your wallet</h2>
          <p className="muted">Your vaults are listed by the factory that made them, under the account that created them.</p>
          <button type="button" className="primary" onClick={connect}>
            Connect wallet
          </button>
        </section>
      ) : problem ? (
        <p className="banner banner-frozen" role="alert">
          {problem}
        </p>
      ) : vaults === null ? (
        <div className="vault-grid">
          {[0, 1, 2].map((i) => (
            <section key={i} className="card vault-card">
              <Skeleton lines={4} />
            </section>
          ))}
        </div>
      ) : vaults.length === 0 ? (
        <section className="card empty-state">
          <h2>No vaults yet</h2>
          <p className="muted">
            A vault holds your agent's money and enforces your rules on every payment. It takes about two minutes.
          </p>
          <a className="button primary" href="?create">
            Create your first vault
          </a>
        </section>
      ) : (
        <>
          <div className="vault-grid">
            {vaults.map((owned) => (
              <VaultCard key={owned.vault} owned={owned} />
            ))}
            <a className="card vault-card vault-card-new" href="?create">
              <span className="plus">+</span>
              <span>New vault</span>
            </a>
          </div>
          <Explainer>
            Only vaults {account} created through the factory are listed. To open any other vault, such as one where
            you're the guardian, type its name in the search box at the top.
          </Explainer>
        </>
      )}
    </div>
  );
}

function VaultCard({ owned }: { owned: Owned }) {
  const { vault, agent, frozen, waiting, payees, hosted } = owned;
  const [name, ...rest] = vault.split(".");
  return (
    <a className="card vault-card" href={`?vault=${encodeURIComponent(vault)}`}>
      <div className="vault-card-top">
        <Identicon seed={vault} size={36} />
        <div className="vault-card-name">
          <strong>{name}</strong>
          <span className="muted small mono">.{rest.join(".")}</span>
        </div>
        <span className={`pill ${frozen ? "pill-frozen" : "pill-live"}`}>
          <span className="dot" />
          {frozen ? "Frozen" : "Active"}
        </span>
      </div>
      <dl className="vault-card-facts">
        <div className="fact-wide">
          <dt>Agent</dt>
          <dd className="mono small" title={agent ?? undefined}>
            {agent ?? "unknown"}
          </dd>
        </div>
        <div>
          <dt>Payees</dt>
          <dd>{payees ?? "–"}</dd>
        </div>
        <div>
          <dt>Waiting</dt>
          <dd className={waiting ? "attention-text" : undefined}>{waiting ?? "–"}</dd>
        </div>
      </dl>
      <div className="vault-card-foot">
        {hosted && (
          <span className="badge" title="The agent's key is held in the hosted connector's OutLayer enclave, for AI apps that connect by URL">
            Hosted agent
          </span>
        )}
        {waiting ? <span className="badge badge-warn">{waiting} to review</span> : null}
        <span className="spacer" />
        <span className="muted small">Open →</span>
      </div>
    </a>
  );
}

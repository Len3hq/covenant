import { useEffect, useState } from "react";
import { FACTORY_ID, vaultsOf, type VaultConfig } from "./vault";

/** Factories that made vaults before the current one, which still answer `vaults_of`. */
export const OLDER_FACTORIES = ["vaults.len3hq.testnet"];

interface Owned {
  vault: string;
  agent: string | null;
  frozen: boolean | null;
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
        const names = await ownedVaults(config, account, fetcher);
        const found = await Promise.all(
          names.map(async (vault): Promise<Owned> => {
            const [roles, frozen] = await Promise.all([
              view<{ agent: string }>(config, vault, "get_roles", fetcher).catch(() => null),
              view<boolean>(config, vault, "is_frozen", fetcher).catch(() => null),
            ]);
            return { vault, agent: roles?.agent ?? null, frozen };
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
    <section className="card create">
      <h2>My vaults</h2>
      {!account ? (
        <>
          <p className="muted small">Connect the wallet that created your vaults to list them.</p>
          <button type="button" className="primary" onClick={connect}>
            Connect a NEAR wallet
          </button>
        </>
      ) : problem ? (
        <p className="banner banner-frozen" role="alert">
          {problem}
        </p>
      ) : vaults === null ? (
        <p className="muted small">Looking up {account}'s vaults…</p>
      ) : vaults.length === 0 ? (
        <p className="muted small">
          {account} owns no vaults the factory made. <a href="?create">Create one</a>, or open a vault you know by name with the
          box at the top.
        </p>
      ) : (
        <>
          <p className="muted small">
            Every vault {account} created through the factory. A vault made another way, or owned by another account, isn't
            listed; open it by name with the box at the top.
          </p>
          <ul className="my-vaults">
            {vaults.map(({ vault, agent, frozen }) => (
              <li key={vault}>
                <a className="mono" href={`?vault=${encodeURIComponent(vault)}`}>
                  {vault}
                </a>
                <span className="muted small">
                  {agent ? ` agent ${agent}` : ""}
                  {frozen ? " · frozen" : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

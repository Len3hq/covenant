/* Per-vault MCP addresses: `/v/<vault>/mcp`. */

/** A NEAR testnet account name, as a vault's is. */
export const isVaultName = (name: string) => /^[a-z0-9][a-z0-9._-]{1,62}\.testnet$/.test(name);

/** The vault a per-vault MCP address names, or null for the shared `/mcp`. */
export function vaultOfResource(resource: URL | undefined): string | null {
  const match = resource ? /^\/v\/([^/]+)\/mcp\/?$/.exec(resource.pathname) : null;
  return match?.[1] && isVaultName(match[1]) ? match[1] : null;
}

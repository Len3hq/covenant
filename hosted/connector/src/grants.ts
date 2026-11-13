import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Grant, Terms } from "./grant.js";

/**
 * The newest grant for each hosted vault, kept on the connector's volume so it can send held
 * payments when their wait ends, with no one signed in. A grant holds no key: the enclave checks
 * it again before every signature, and it stops working when it expires.
 */
export class GrantStore {
  private readonly grants = new Map<string, { terms: Terms; grant: Grant }>();

  constructor(private readonly path: string) {
    try {
      for (const entry of JSON.parse(readFileSync(path, "utf8")) as { terms: Terms; grant: Grant }[]) {
        this.grants.set(entry.terms.vault, entry);
      }
    } catch {
      // No file yet, or an unreadable one: start empty, and grants are saved again as they're used.
    }
  }

  /** Keeps `grant` if it's the vault's latest-expiring one. */
  save(terms: Terms, grant: Grant): void {
    const current = this.grants.get(terms.vault);
    if (current && current.terms.expires >= terms.expires) return;
    this.grants.set(terms.vault, { terms, grant });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.grants.values()], null, 2));
    renameSync(temporary, this.path);
  }

  /** The vault's newest grant, expired or not: the enclave refuses an expired one. */
  forVault(vault: string): { terms: Terms; grant: Grant } | undefined {
    return this.grants.get(vault);
  }

  /** The grants that haven't expired. */
  live(nowSeconds: number = Date.now() / 1000): { terms: Terms; grant: Grant }[] {
    return [...this.grants.values()].filter(({ terms }) => terms.expires > nowSeconds);
  }
}

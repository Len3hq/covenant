import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Grant, Terms } from "./grant.js";
import { GrantStore } from "./grants.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = () => {
  const dir = mkdtempSync(join(tmpdir(), "grants-"));
  dirs.push(dir);
  return join(dir, "grants.json");
};
const terms = (vault: string, expires: number): Terms => ({ owner: "o.testnet", vault, agent: "a.testnet", expires });
const grant = (signature: string): Grant => ({ message: "m", nonce: "n", public_key: "ed25519:k", signature });

describe("GrantStore", () => {
  it("keeps each vault's latest-expiring grant, and survives a restart", () => {
    const path = file();
    const store = new GrantStore(path);
    store.save(terms("v1", 200), grant("new"));
    store.save(terms("v1", 100), grant("older"));
    store.save(terms("v2", 300), grant("other"));
    const reopened = new GrantStore(path);
    expect(reopened.forVault("v1")?.grant.signature).toBe("new");
    expect(reopened.live(150).map(({ terms }) => terms.vault)).toEqual(["v1", "v2"]);
    expect(reopened.live(250).map(({ terms }) => terms.vault)).toEqual(["v2"]);
  });

  it("starts empty without a file", () => {
    expect(new GrantStore(file()).live()).toEqual([]);
  });
});

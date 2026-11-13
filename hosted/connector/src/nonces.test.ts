import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nonceKeeper, NonceStore } from "./nonces.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), "nonces-"));
  dirs.push(dir);
  return new NonceStore(dir);
};

describe("nonceKeeper", () => {
  it("tops a vault up to two accounts whose authority is the vault, and stops there", async () => {
    const nonces = store();
    let n = 0;
    const create = vi.fn(async (authority: string) => `${authority}-nonce-${++n}`);
    const ensure = nonceKeeper({ store: nonces, create });
    await ensure("v.testnet", async () => "SoLvault");
    expect(nonces.list("v.testnet")).toEqual(["SoLvault-nonce-1", "SoLvault-nonce-2"]);
    await ensure("v.testnet", async () => "SoLvault");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("creates them once when two requests ask at the same time", async () => {
    const nonces = store();
    let n = 0;
    const create = vi.fn(async () => `nonce-${++n}`);
    const ensure = nonceKeeper({ store: nonces, create });
    await Promise.all([ensure("v.testnet", async () => "S"), ensure("v.testnet", async () => "S")]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(nonces.list("v.testnet")).toHaveLength(2);
  });

  it("skips a vault without a Solana address, and tries again after a failure", async () => {
    const nonces = store();
    const create = vi.fn().mockRejectedValueOnce(new Error("funder is empty")).mockResolvedValue("nonce-x");
    const ensure = nonceKeeper({ store: nonces, create, want: 1 });
    await ensure("old.testnet", async () => undefined);
    expect(create).not.toHaveBeenCalled();
    await expect(ensure("v.testnet", async () => "S")).rejects.toThrow("funder is empty");
    await ensure("v.testnet", async () => "S");
    expect(nonces.list("v.testnet")).toEqual(["nonce-x"]);
  });
});

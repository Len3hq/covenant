import { describe, expect, it, vi } from "vitest";
import { ownedVaults } from "./MyVaults";

const config = { rpcUrl: "https://rpc.example", accountId: "x" } as never;

/** An RPC that answers `vaults_of` per factory, and fails for one. */
const rpc = (answers: Record<string, string[] | "fail">) =>
  vi.fn(async (_url: string, init: RequestInit) => {
    const { params } = JSON.parse(String(init.body)) as { params: { account_id: string } };
    const answer = answers[params.account_id];
    if (answer === "fail" || !answer) return new Response(JSON.stringify({ error: "nope" }));
    const bytes = [...new TextEncoder().encode(JSON.stringify(answer))];
    return new Response(JSON.stringify({ result: { result: bytes } }));
  }) as unknown as typeof fetch;

describe("ownedVaults", () => {
  it("lists the owner's vaults from every factory, once each", async () => {
    const fetcher = rpc({ new: ["a.new", "b.new"], old: ["c.old", "a.new"] });
    expect(await ownedVaults(config, "me.testnet", fetcher, ["new", "old"])).toEqual(["a.new", "b.new", "c.old"]);
  });

  it("still lists the others when one factory doesn't answer", async () => {
    const fetcher = rpc({ new: ["a.new"], old: "fail" });
    expect(await ownedVaults(config, "me.testnet", fetcher, ["new", "old"])).toEqual(["a.new"]);
  });
});

describe("hasVaultKey", () => {
  const answering = (result: unknown) => (async () => new Response(JSON.stringify({ result }))) as unknown as typeof fetch;
  it("counts only a key scoped to the vault, not NEAR's answer for a missing key", async () => {
    const { hasVaultKey } = await import("./MyVaults");
    const missing = answering({ error: "access key ed25519:x does not exist while viewing", logs: [] });
    expect(await hasVaultKey(config, "a.testnet", "ed25519:x", "v.testnet", missing)).toBe(false);
    const scoped = answering({ permission: { FunctionCall: { receiver_id: "v.testnet", method_names: [] } } });
    expect(await hasVaultKey(config, "a.testnet", "ed25519:x", "v.testnet", scoped)).toBe(true);
    expect(await hasVaultKey(config, "a.testnet", "ed25519:x", "other.testnet", scoped)).toBe(false);
    expect(await hasVaultKey(config, "a.testnet", "ed25519:x", "v.testnet", answering({ permission: "FullAccess" }))).toBe(false);
  });
});

describe("MyVaults while the wallet loads", () => {
  it("shows placeholders, not the connect prompt, until the wallet has answered", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { MyVaults } = await import("./MyVaults");
    const page = (checking: boolean) =>
      renderToString(createElement(MyVaults, { config, fetcher: fetch, account: null, connect: () => {}, checking }));
    expect(page(true)).toContain('aria-busy="true"');
    expect(page(true)).not.toContain("Connect your wallet");
    expect(page(false)).toContain("Connect your wallet");
  });
});

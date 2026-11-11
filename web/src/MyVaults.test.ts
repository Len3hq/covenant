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

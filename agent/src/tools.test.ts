import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmTurn, ToolResult } from "./llm/index.js";
import { runAgent } from "./loop.js";
import type { Payer } from "./payer.js";
import { createTools, spendKey, type ToolDeps } from "./tools.js";
import type { AgentVault } from "./vault.js";

const EVM_PAYEE = Array.from({ length: 20 }, () => 0xaa);
const BTC_PAYEE = [0, 20, ...Array.from({ length: 20 }, () => 0xab)];

function setup() {
  const spend = vi.fn(async (_key: string, _description: string, prepare: () => Promise<unknown>) => {
    await prepare();
    return { status: "broadcast", links: {} };
  });
  const vault = {
    payees: async () => [
      { chain: "Bitcoin", to: BTC_PAYEE, label: "Acme Hosting" },
      { chain: "Evm", to: EVM_PAYEE, label: "DesignCo" },
    ],
    evmAddress: async () => `0x${"bb".repeat(20)}`,
    queue: async () => [{ id: "3", executable_at: "100" }],
    spent24h: async () => "7",
  };
  const chain = {
    chainId: 84532,
    pendingNonce: async () => 1,
    fees: async () => ({ maxFeePerGas: 6n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 50_000n,
    broadcast: async () => "0x" as const,
  };
  const deps: ToolDeps = {
    vault: vault as unknown as AgentVault,
    payer: { spend, execute: vi.fn() } as unknown as Payer,
    reads: { btcBalance: async () => 1n, ethBalance: async () => 2n, tokenBalance: async () => 3n },
    bitcoin: {} as ToolDeps["bitcoin"],
    chain,
    usdc: `0x${"03".repeat(20)}`,
    runId: "run",
  };
  const tools = createTools(deps);
  const run = (name: string, input: unknown) => {
    const found = tools.find((tool) => tool.spec.name === name);
    if (!found) throw new Error(name);
    return found.run(input);
  };
  return { run, spend, tools };
}

describe("tools", () => {
  it("offers exactly the tools in the spec, each with a schema", () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.spec.name)).toEqual([
      "get_balances",
      "list_payees",
      "pay",
      "evm_call",
      "spend_status",
      "execute_queued",
    ]);
    expect(tools.every((tool) => tool.spec.parameters.type === "object")).toBe(true);
  });

  it("lists payees with readable addresses", async () => {
    const payees = (await setup().run("list_payees", {})) as { label: string; address: string }[];
    expect(payees[0]?.address).toMatch(/^tb1q/);
    expect(payees[1]?.address).toMatch(/^0x[aA]{40}$/);
  });

  it("resolves a label for the asset's chain, and passes any other address through", async () => {
    const { run, spend } = setup();
    await run("pay", { to: "designco", asset: "ETH", amount: "5", memo: "m" });
    expect(String(spend.mock.calls[0]?.[1]).toLowerCase()).toContain(`0x${"aa".repeat(20)}`);
    // An unlisted address reaches the contract, because refusing it is the contract's job.
    const stranger = `0x${"cc".repeat(20)}`;
    await run("pay", { to: stranger, asset: "ETH", amount: "5", memo: "m" });
    expect(String(spend.mock.calls[1]?.[1]).toLowerCase()).toContain(stranger);
  });

  it("gives the same spend the same key within a run, and a new key in a new run", () => {
    expect(spendKey("run", "pay", "a")).toBe(spendKey("run", "pay", "a"));
    expect(spendKey("run2", "pay", "a")).not.toBe(spendKey("run", "pay", "a"));
  });

  it("takes whole base units only", async () => {
    await expect(setup().run("pay", { to: "x", asset: "BTC", amount: "1.5", memo: "m" })).rejects.toThrow();
    await expect(setup().run("evm_call", { to: `0x${"cc".repeat(20)}`, data: "zz", value: "0" })).rejects.toThrow();
  });

  it("sends raw calls on, so an injected approve reaches the contract", async () => {
    const { run, spend } = setup();
    await run("evm_call", { to: `0x${"cc".repeat(20)}`, data: "0x095ea7b3", value: "0" });
    expect(spend).toHaveBeenCalledOnce();
  });

  it("reports the queue", async () => {
    const { run } = setup();
    expect(await run("spend_status", { id: "3" })).toEqual({ queued: true, executableAt: "100" });
    expect(await run("spend_status", { id: "4" })).toMatchObject({ queued: false });
  });
});

describe("runAgent", () => {
  function scripted(turns: LlmTurn[]) {
    const seen: ToolResult[][] = [];
    const llm: LlmClient = {
      start: () => ({
        next: async (results) => {
          seen.push(results);
          const turn = turns.shift();
          if (!turn) throw new Error("no more turns");
          return turn;
        },
      }),
    };
    return { llm, seen };
  }
  const args = { system: "s", user: "u", log: () => undefined };

  it("feeds tool results back until the model stops, reporting errors to it", async () => {
    const { tools } = setup();
    const { llm, seen } = scripted([
      {
        text: "",
        calls: [
          { id: "1", name: "spend_status", input: { id: "3" } },
          { id: "2", name: "pay", input: { amount: "bad" } },
          { id: "3", name: "invented", input: {} },
        ],
      },
      { text: "Finished", calls: [] },
    ]);
    expect(await runAgent({ ...args, llm, tools })).toBe("Finished");
    expect(seen[1]?.map((result) => result.isError)).toEqual([false, true, true]);
    expect(seen[1]?.[2]?.content).toContain("no tool named invented");
  });

  it("stops a model that never finishes", async () => {
    const { tools } = setup();
    const turns = Array.from({ length: 20 }, () => ({
      text: "",
      calls: [{ id: "1", name: "spend_status", input: { id: "3" } }],
    }));
    await expect(runAgent({ ...args, llm: scripted(turns).llm, tools })).rejects.toThrow("still calling tools");
  });
});

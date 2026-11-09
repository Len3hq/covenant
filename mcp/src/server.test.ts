import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer, type Wallet } from "./server.js";

async function connect(wallet: Partial<Wallet>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(wallet as Wallet).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const body = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as { text: string }[])[0]?.text ?? "null") as unknown;

describe("the Covenant MCP server", () => {
  it("offers the vault's tools", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["execute_queued", "get_addresses", "get_balances", "list_payees", "list_queue", "pay"].sort(),
    );
  });

  it("passes amounts to the wallet as exact integers, and returns the vault's verdict", async () => {
    const pay = vi.fn(async () => ({ status: "rejected" as const, error: "OutputNotWhitelisted", links: {} }));
    const client = await connect({ pay });
    const result = await client.callTool({
      name: "pay",
      arguments: { asset: "ETH", to: "0xbad", amount: "123456789012345678901", reference: "INV-1" },
    });
    expect(pay).toHaveBeenCalledWith({ asset: "ETH", to: "0xbad", amount: 123456789012345678901n, reference: "INV-1" });
    expect(body(result)).toMatchObject({ status: "rejected", error: "OutputNotWhitelisted" });
  });

  it("refuses an amount that isn't a whole number before asking the vault", async () => {
    const pay = vi.fn();
    const client = await connect({ pay });
    const result = await client.callTool({
      name: "pay",
      arguments: { asset: "BTC", to: "Acme", amount: "0.5", reference: "INV-2" },
    });
    expect(result.isError).toBe(true);
    expect(pay).not.toHaveBeenCalled();
  });

  it("returns bigint balances as strings", async () => {
    const balances = vi.fn(async () => ({
      BTC: { balance: 657782n, spent24h: 0n },
      ETH: { balance: 1n, spent24h: 0n },
      USDC: { balance: 18000000n, spent24h: 0n },
    }));
    const client = await connect({ balances });
    expect(body(await client.callTool({ name: "get_balances", arguments: {} }))).toMatchObject({
      BTC: { balance: "657782" },
    });
  });
});

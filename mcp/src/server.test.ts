import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer, type Wallet } from "./server.js";

async function connect(wallet: Partial<Wallet>, vault?: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(wallet as Wallet, vault ? { vault } : {}).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const body = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as { text: string }[])[0]?.text ?? "null") as unknown;

describe("the Covenant MCP server", () => {
  it("tells the assistant which vault its tools act on", async () => {
    const client = await connect({}, "acme.vaults-v3.len3hq.testnet");
    expect(client.getInstructions()).toContain("acme.vaults-v3.len3hq.testnet");
  });

  it("offers the vault's tools", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "execute_queued",
        "get_addresses",
        "get_balances",
        "get_payment_status",
        "list_destinations",
        "list_payees",
        "list_queue",
        "pay",
        "quote_payment",
      ].sort(),
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

  it("pays SOL and Solana USDC, and refuses an asset it doesn't know", async () => {
    const pay = vi.fn(async () => ({ status: "broadcast" as const, links: {} }));
    const client = await connect({ pay });
    for (const asset of ["SOL", "USDC-SOL"]) {
      await client.callTool({ name: "pay", arguments: { asset, to: "Acme", amount: "5", reference: `INV-${asset}` } });
    }
    expect(pay).toHaveBeenCalledTimes(2);
    expect(pay).toHaveBeenLastCalledWith({ asset: "USDC-SOL", to: "Acme", amount: 5n, reference: "INV-USDC-SOL" });
    const unknown = await client.callTool({
      name: "pay",
      arguments: { asset: "DOGE", to: "Acme", amount: "5", reference: "INV-3" },
    });
    expect(unknown.isError).toBe(true);
    expect(pay).toHaveBeenCalledTimes(2);
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

  it("pays across chains by passing the target chain and token to the wallet", async () => {
    const pay = vi.fn(async () => ({ status: "broadcast" as const, links: {} }));
    const client = await connect({ pay });
    await client.callTool({
      name: "pay",
      arguments: {
        asset: "BTC",
        to: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        amount: "20000",
        reference: "INV-9",
        to_chain: "solana",
        to_asset: "USDC",
      },
    });
    expect(pay).toHaveBeenCalledWith({
      asset: "BTC",
      to: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: 20_000n,
      reference: "INV-9",
      toChain: "solana",
      toAsset: "USDC",
    });
  });

  it("previews a swap and reports a swap's status by reference", async () => {
    const quoteSwap = vi.fn(async () => ({ amountIn: "20000", amountOut: "14661630", minAmountOut: "14515013", asset: "x" }));
    const swapStatus = vi.fn(async () => ({ status: "broadcast" as const, swap: { to: "a", asset: "x", minAmountOut: "1", deadline: "d", status: "SUCCESS" }, links: {} }));
    const client = await connect({ quoteSwap, swapStatus });
    const quote = await client.callTool({ name: "quote_payment", arguments: { asset: "BTC", to: "a", amount: "20000", to_chain: "base", to_asset: "USDC" } });
    expect(quoteSwap).toHaveBeenCalledWith({ asset: "BTC", to: "a", amount: 20_000n, toChain: "base", toAsset: "USDC" });
    expect(body(quote)).toMatchObject({ amountOut: "14661630" });
    const status = await client.callTool({ name: "get_payment_status", arguments: { reference: "INV-9" } });
    expect(body(status)).toMatchObject({ swap: { status: "SUCCESS" } });
  });
});

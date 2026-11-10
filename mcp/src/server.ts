import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ASSETS, type Covenant } from "@covenant/sdk";
import { z } from "zod";

/** The parts of a Covenant wallet the tools use, so tests can stand in for the chains. */
export type Wallet = Pick<Covenant, "pay" | "execute" | "payees" | "balances" | "queue" | "addresses">;

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2),
    },
  ],
});

/**
 * The vault decides every payment, so these tools need no guard of their own: a fooled assistant
 * can ask for anything, and the vault refuses what its policy doesn't allow.
 */
export function createServer(wallet: Wallet): McpServer {
  const server = new McpServer({ name: "covenant", version: "0.1.0" });

  server.registerTool(
    "pay",
    {
      title: "Pay from the vault",
      description:
        "Pays from the Covenant vault. `amount` is a whole number of base units: sats for BTC, wei for ETH, lamports for SOL, and 1000000 is 1 USDC. `USDC` is on Base and `USDC-SOL` is on Solana. `to` is a payee's name from list_payees, or an address. `reference` names what the payment is for, such as an invoice number; the same reference never pays twice. The result is `broadcast` (paid), `queued` (large, waiting out a veto window), or `rejected` with the rule it broke. A rejection is final: don't retry it another way.",
      inputSchema: {
        asset: z.enum(ASSETS),
        to: z.string().min(1),
        amount: z.string().regex(/^\d+$/, "a whole number of base units"),
        reference: z.string().min(1),
      },
    },
    async ({ asset, to, amount, reference }) =>
      text(await wallet.pay({ asset, to, amount: BigInt(amount), reference })),
  );

  server.registerTool(
    "list_payees",
    { title: "Who the vault may pay", description: "The payees the vault's policy allows. Everything else is refused." },
    async () => text(await wallet.payees()),
  );

  server.registerTool(
    "get_balances",
    {
      title: "Vault balances",
      description: "What the vault holds and has spent in the last 24 hours, in whole base units.",
    },
    async () => text(await wallet.balances()),
  );

  server.registerTool(
    "get_addresses",
    { title: "Vault addresses", description: "The vault's Bitcoin testnet4, Base Sepolia and Solana devnet addresses, to fund it." },
    async () => text(await wallet.addresses()),
  );

  server.registerTool(
    "list_queue",
    {
      title: "Queued payments",
      description: "Payments waiting out the veto window, with when each can execute (nanoseconds since the epoch).",
    },
    async () => text(await wallet.queue()),
  );

  server.registerTool(
    "execute_queued",
    {
      title: "Execute a queued payment",
      description: "Signs and broadcasts a queued payment whose veto window has passed. The vault checks it again first.",
      inputSchema: { id: z.string().regex(/^\d+$/) },
    },
    async ({ id }) => text(await wallet.execute(id)),
  );

  return server;
}

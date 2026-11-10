import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ASSETS, type Covenant } from "@covenant/sdk";
import { z } from "zod";

/** The parts of a Covenant wallet the tools use, so tests can stand in for the chains. */
export type Wallet = Pick<
  Covenant,
  "pay" | "execute" | "payees" | "balances" | "queue" | "addresses" | "quoteSwap" | "swapStatus" | "destinations"
>;

const SWAP_CHAIN = z
  .string()
  .min(1)
  .optional()
  .describe("The chain the recipient is paid on, such as bitcoin, base, arbitrum, ethereum, bsc, solana, stellar, sui, xrp or near.");
const SWAP_ASSET = z
  .string()
  .min(1)
  .optional()
  .describe("The token the recipient gets on to_chain, such as USDC, USDT, ETH, SOL or BTC.");

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
        "Pays from the Covenant vault. `amount` is a whole number of base units: sats for BTC, wei for ETH, lamports for SOL, and 1000000 is 1 USDC. `USDC` is on Base and `USDC-SOL` is on Solana. `to` is a payee's name from list_payees, or an address. To pay on another chain or in another token, set `to_chain` and `to_asset`: `asset` (BTC, ETH or SOL) leaves the vault and is swapped, and `to` is then an address on `to_chain`; check quote_payment and list_destinations first. `reference` names what the payment is for, such as an invoice number; the same reference never pays twice. The result is `broadcast` (paid), `queued` (large, or to an address off the payee list on a vault that holds new payees, waiting out a veto window), or `rejected` with the rule it broke. A queued payment isn't a failure: a human may veto it, and execute_queued signs it once its window passes. A rejection is final: don't retry it another way.",
      inputSchema: {
        asset: z.enum(ASSETS),
        to: z.string().min(1),
        amount: z.string().regex(/^\d+$/, "a whole number of base units"),
        reference: z.string().min(1),
        to_chain: SWAP_CHAIN,
        to_asset: SWAP_ASSET,
      },
    },
    async ({ asset, to, amount, reference, to_chain, to_asset }) =>
      text(
        await wallet.pay({
          asset,
          to,
          amount: BigInt(amount),
          reference,
          ...(to_chain ? { toChain: to_chain } : {}),
          ...(to_asset ? { toAsset: to_asset } : {}),
        }),
      ),
  );

  server.registerTool(
    "quote_payment",
    {
      title: "Preview a cross-chain payment",
      description:
        "What a payment through a swap would deliver: `amount` of `asset` leaves the vault, and the recipient gets about `amountOut`, and at least `minAmountOut`, of `to_asset` on `to_chain`, in that token's base units. Spends nothing.",
      inputSchema: {
        asset: z.enum(ASSETS),
        to: z.string().min(1),
        amount: z.string().regex(/^\d+$/, "a whole number of base units"),
        to_chain: SWAP_CHAIN,
        to_asset: SWAP_ASSET,
      },
    },
    async ({ asset, to, amount, to_chain, to_asset }) =>
      text(
        await wallet.quoteSwap({
          asset,
          to,
          amount: BigInt(amount),
          ...(to_chain ? { toChain: to_chain } : {}),
          ...(to_asset ? { toAsset: to_asset } : {}),
        }),
      ),
  );

  server.registerTool(
    "list_destinations",
    {
      title: "Where swaps may deliver",
      description: "The chains and tokens the vault's policy lets a cross-chain payment deliver, with each token's decimals.",
    },
    async () => text(await wallet.destinations()),
  );

  server.registerTool(
    "get_payment_status",
    {
      title: "Cross-chain payment status",
      description:
        "Where a cross-chain payment stands, by its reference: PENDING_DEPOSIT or PROCESSING (on its way), SUCCESS (delivered), REFUNDED (returned to the vault) or FAILED.",
      inputSchema: { reference: z.string().min(1) },
    },
    async ({ reference }) => text(await wallet.swapStatus(reference)),
  );

  server.registerTool(
    "list_payees",
    { title: "Who the vault may pay", description: "The payees on the vault's list. Depending on the vault's policy, anyone else is either refused or held for a longer veto window within a smaller daily limit." },
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

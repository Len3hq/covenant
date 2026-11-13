import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { ASSETS, type Covenant } from "@len3hq/covenant-sdk";
import { z } from "zod";

/** The parts of a Covenant wallet the tools use, so tests can stand in for the chains. */
export type Wallet = Pick<
  Covenant,
  "pay" | "execute" | "payees" | "balances" | "queue" | "addresses" | "quoteSwap" | "swapStatus" | "destinations"
>;

/** The server reports its own package version, so it can't drift from what npm installed. */
const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

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
 * What each tool does to the world, for apps that ask before acting. ChatGPT treats a tool without
 * `readOnlyHint` as a write and may hold it back, so the reads say they only read.
 */
const READS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const SPENDS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

/** The vault's records that `search` finds and `fetch` reads, for apps that only use those two. */
const RECORDS = {
  balances: { title: "Vault balances", words: "balance balances holdings funds spent limit money btc eth usdc sol", read: (w: Wallet) => w.balances() },
  addresses: { title: "Vault addresses", words: "address addresses deposit fund receive wallet bitcoin evm base solana", read: (w: Wallet) => w.addresses() },
  payees: { title: "Vault payees", words: "payee payees recipients whitelist allowed contacts who pay", read: (w: Wallet) => w.payees() },
  queue: { title: "Queued payments", words: "queue queued pending held veto waiting payments", read: (w: Wallet) => w.queue() },
  destinations: { title: "Cross-chain destinations", words: "destinations swap chains tokens cross-chain bridge", read: (w: Wallet) => w.destinations() },
} as const;
type RecordId = keyof typeof RECORDS;
const RECORD_IDS = Object.keys(RECORDS) as RecordId[];

/**
 * The vault decides every payment, so these tools need no guard of their own: a fooled assistant
 * can ask for anything, and the vault refuses what its policy doesn't allow.
 */
export function createServer(wallet: Wallet, options: { vault?: string } = {}): McpServer {
  // Naming the vault lets an assistant that holds several of them, one connector each, tell which
  // one these tools act on.
  const server = new McpServer(
    { name: "covenant", version: PACKAGE_VERSION },
    options.vault
      ? {
          instructions: `These tools act on one Covenant vault: ${options.vault}. Every balance, address, payee and payment here is that vault's. Another vault is reached through its own connector.`,
        }
      : {},
  );

  server.registerTool(
    "pay",
    {
      title: "Pay from the vault",
      annotations: SPENDS,
      description:
        "Pays from the Covenant vault. `amount` is a whole number of base units: sats for BTC, wei for ETH, lamports for SOL, and 1000000 is 1 USDC. `USDC` is on Base and `USDC-SOL` is on Solana. `to` is a payee's name from list_payees, or an address. To pay on another chain or in another token, set `to_chain` and `to_asset`: `asset` (BTC, ETH or SOL) leaves the vault and is swapped, and `to` is then an address on `to_chain`; check quote_payment and list_destinations first. `reference` names what the payment is for, such as an invoice number; the same reference never pays twice. The result is `broadcast` (paid), `queued` (large, or to an address off the payee list on a vault that holds new payees, waiting out a veto window), or `rejected` with the rule it broke. A queued payment isn't a failure: a human may veto it during its window, and this server sends it by itself once the window passes (execute_queued does it at once if asked). A rejection is final: don't retry it another way.",
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
      annotations: READS,
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
      annotations: READS,
      description: "The chains and tokens the vault's policy lets a cross-chain payment deliver, with each token's decimals.",
    },
    async () => text(await wallet.destinations()),
  );

  server.registerTool(
    "get_payment_status",
    {
      title: "Cross-chain payment status",
      annotations: READS,
      description:
        "Where a cross-chain payment stands, by its reference: PENDING_DEPOSIT or PROCESSING (on its way), SUCCESS (delivered), REFUNDED (returned to the vault) or FAILED.",
      inputSchema: { reference: z.string().min(1) },
    },
    async ({ reference }) => text(await wallet.swapStatus(reference)),
  );

  server.registerTool(
    "list_payees",
    { title: "Who the vault may pay", annotations: READS, description: "The payees on the vault's list. Depending on the vault's policy, anyone else is either refused or held for a longer veto window within a smaller daily limit." },
    async () => text(await wallet.payees()),
  );

  server.registerTool(
    "get_balances",
    {
      title: "Vault balances",
      annotations: READS,
      description: "What the vault holds and has spent in the last 24 hours, in whole base units.",
    },
    async () => text(await wallet.balances()),
  );

  server.registerTool(
    "get_addresses",
    { title: "Vault addresses", annotations: READS, description: "The vault's Bitcoin testnet4, Base Sepolia and Solana devnet addresses, to fund it." },
    async () => text(await wallet.addresses()),
  );

  server.registerTool(
    "list_queue",
    {
      title: "Queued payments",
      annotations: READS,
      description: "Payments waiting out the veto window, with when each can execute (nanoseconds since the epoch).",
    },
    async () => text(await wallet.queue()),
  );

  server.registerTool(
    "execute_queued",
    {
      title: "Execute a queued payment",
      annotations: SPENDS,
      description: "Signs and broadcasts a queued payment whose veto window has passed. The vault checks it again first.",
      inputSchema: { id: z.string().regex(/^\d+$/) },
    },
    async ({ id }) => text(await wallet.execute(id)),
  );

  /*
   * ChatGPT, outside developer mode, gives its model only tools named `search` and `fetch`, in this
   * shape. They read the same records as the tools above, so the vault can be read there too.
   */
  const recordUrl = (id: RecordId) =>
    `https://covenant.len3.xyz/${options.vault ? `?vault=${encodeURIComponent(options.vault)}` : ""}#${id}`;

  server.registerTool(
    "search",
    {
      title: "Find vault records",
      annotations: READS,
      description:
        "Finds this Covenant vault's records: balances, addresses, payees, queued payments and cross-chain destinations. Returns ids to read with fetch.",
      inputSchema: { query: z.string().describe("What to look for, such as balances or addresses.") },
    },
    async ({ query }) => {
      const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter((word) => word.length >= 3);
      const hits = RECORD_IDS.filter((id) => words.some((word) => id === word || RECORDS[id].words.split(" ").includes(word)));
      const results = (hits.length > 0 ? hits : RECORD_IDS).map((id) => ({ id, title: RECORDS[id].title, url: recordUrl(id) }));
      return text({ results });
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Read a vault record",
      annotations: READS,
      description: `Reads one of this vault's records by its id from search: ${RECORD_IDS.join(", ")}.`,
      inputSchema: { id: z.string().describe(`One of ${RECORD_IDS.join(", ")}.`) },
    },
    async ({ id }) => {
      if (!(RECORD_IDS as string[]).includes(id)) throw new Error(`no record ${id}; the records are ${RECORD_IDS.join(", ")}`);
      const record = RECORDS[id as RecordId];
      const data = await record.read(wallet);
      return text({
        id,
        title: record.title,
        text: JSON.stringify(data, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2),
        url: recordUrl(id as RecordId),
        metadata: options.vault ? { vault: options.vault } : {},
      });
    },
  );

  return server;
}

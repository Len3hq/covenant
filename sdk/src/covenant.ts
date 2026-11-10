import { hexToBytes } from "viem";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, hex } from "@scure/base";
import { jsonLog, type Log } from "./log.js";
import { Payer, report, type SpendReport } from "./payer.js";
import { payeeAddress, preparePayment, resolvePayee, type Asset } from "./payments.js";
import { SpendStore } from "./store.js";
import { connectTestnet, TESTNET, type ConnectOptions } from "./testnet.js";
import { Tidepool, TIDEPOOL, type SwapOrigin, type Token } from "./tidepool.js";
import type { QueuedSpend, Timing } from "./vault.js";

const HOUR_MS = 3_600_000;
/** Tidepool's chain names, with the common names people use for them. */
const CHAIN_NAMES: Record<string, string> = {
  bitcoin: "btc",
  btc: "btc",
  base: "base",
  arbitrum: "arb",
  arb: "arb",
  ethereum: "eth",
  eth: "eth",
  bsc: "bsc",
  solana: "sol",
  sol: "sol",
  stellar: "stellar",
  sui: "sui",
  xrp: "xrp",
  near: "near",
};

export function tidepoolChain(name: string): string {
  const chain = CHAIN_NAMES[name.trim().toLowerCase()];
  if (!chain) throw new Error(`unknown chain "${name}"; use one of ${[...new Set(Object.values(CHAIN_NAMES))].join(", ")}`);
  return chain;
}

/**
 * How long a swap's quote stays open: long enough for the longest veto window it might wait out,
 * plus the vault's deposit window and an hour to spare, within Tidepool's one-day limit.
 */
export function quoteDeadline(timing: Timing, nowMs: number): Date {
  const window = timing.swap?.min_deposit_window_ns ?? 0;
  const delay = Math.max(timing.veto_delay_ns, timing.unlisted_veto_delay_ns ?? 0);
  const needed = (delay + window) / 1_000_000 + HOUR_MS;
  return new Date(nowMs + Math.min(Math.max(needed, 2 * HOUR_MS), 23 * HOUR_MS));
}

export interface CovenantOptions extends ConnectOptions {
  /**
   * Where each payment's progress is written before every step, so a crash or retry never pays
   * twice. Keep it on storage that survives restarts. Defaults to `covenant-spends.json`.
   */
  spendsFile?: string;
  /** Receives each step as it happens. Defaults to JSON lines on stderr; pass `() => {}` to silence. */
  log?: Log;
  tidepoolUrl?: string;
  /** The key Tidepool's quotes are signed with. The vault's policy pins its own copy. */
  tidepoolMakerKey?: string;
}

export interface PayRequest {
  asset: Asset;
  /** A payee's label from the vault's policy, or an address. */
  to: string;
  /** Whole base units: sats for BTC, wei for ETH, lamports for SOL, and 1_000_000n is 1 USDC. */
  amount: bigint;
  /**
   * What this payment is for, such as an invoice number. The same reference never pays twice: a
   * second call returns the first one's result, or finishes it if it was interrupted.
   */
  reference: string;
  /**
   * Pays on another chain or in another token through Tidepool: `asset` leaves the vault, and the
   * recipient gets `toAsset` on `toChain`, such as `USDC` on `solana`. `to` is then an address on
   * `toChain`, or a swap payee's label. Only BTC, ETH, USDC (on Base) and SOL can be swapped from.
   */
  toChain?: string;
  toAsset?: string;
}

/**
 * The outcome of a payment.
 * - `broadcast`: the vault agreed, NEAR's MPC network signed it, and it was sent to the chain.
 * - `queued`: it's large enough to wait out the veto window. Call `execute(id)` after `executableAt`.
 * - `rejected`: the vault refused it, and `error` names the rule. Nothing was signed.
 */
export type Payment = SpendReport;

export interface Payee {
  label: string;
  chain: "Bitcoin" | "Evm" | "Solana";
  address: string;
}

export interface Balances {
  /** What each asset holds and has spent in the last 24 hours, in whole base units. */
  BTC: { balance: bigint; spent24h: bigint };
  ETH: { balance: bigint; spent24h: bigint };
  USDC: { balance: bigint; spent24h: bigint };
  /** Absent for a vault whose code predates Solana support. */
  SOL?: { balance: bigint; spent24h: bigint };
  "USDC-SOL"?: { balance: bigint; spent24h: bigint };
}

const keyOf = (vault: string, reference: string) =>
  hex.encode(sha256(new TextEncoder().encode(`sdk|${vault}|${reference}`)));

/**
 * A policy-enforced wallet for an agent. The agent can ask for any payment; the vault contract on
 * NEAR decides what gets signed, and this client never holds a key that could move funds.
 *
 * ```ts
 * const wallet = Covenant.connect({ vault, agentAccount, agentKey: process.env.AGENT_PRIVATE_KEY! });
 * const result = await wallet.pay({ asset: "BTC", to: "Acme Hosting", amount: 20_000n, reference: "INV-1042" });
 * ```
 */
export class Covenant {
  private readonly store: SpendStore;
  private readonly payer: Payer;
  private readonly tidepool: Tidepool;

  private constructor(
    private readonly options: CovenantOptions,
    private readonly world: ReturnType<typeof connectTestnet>,
  ) {
    this.store = new SpendStore(options.spendsFile ?? "covenant-spends.json");
    this.tidepool = new Tidepool(options.tidepoolUrl, options.tidepoolMakerKey);
    this.payer = new Payer({
      vault: world.vault,
      store: this.store,
      broadcast: world.broadcast,
      log: options.log ?? jsonLog,
    });
  }

  /** Connects to a vault on NEAR testnet, Bitcoin testnet4 and Base Sepolia. */
  static connect(options: CovenantOptions): Covenant {
    return new Covenant(options, connectTestnet(options));
  }

  /** Asks the vault to pay. Resolves once the payment is broadcast, queued or refused. */
  async pay(request: PayRequest): Promise<Payment> {
    const { asset, amount, reference } = request;
    if (typeof amount !== "bigint" || amount <= 0n) throw new Error("amount must be a positive bigint");
    if (!reference.trim()) throw new Error("reference must name what the payment is for");
    if (request.toChain || request.toAsset) return this.paySwap(request);
    const destination = await resolvePayee(this.world.vault, request.to, asset);
    return this.payer.spend(keyOf(this.options.vault, reference), `${amount} ${asset} to ${destination}: ${reference}`, () =>
      preparePayment(
        {
          ...this.world,
          bitcoin: this.world,
          solana: { ...this.world.solana, heldNonces: () => this.store.heldNonces() },
          heldCoins: () => this.store.heldCoins(),
          unfinishedEvm: () => this.store.unfinishedEvm(),
        },
        asset,
        destination,
        amount,
      ),
    );
  }

  /** Signs and broadcasts a queued payment whose veto window has passed. */
  async execute(id: string): Promise<Payment> {
    const result = await this.payer.execute(id);
    const record = this.store.byId(id);
    return record ? this.afterSwapBroadcast(record.key, result) : result;
  }

  private swapDeps() {
    return {
      ...this.world,
      bitcoin: this.world,
      solana: { ...this.world.solana, heldNonces: () => this.store.heldNonces() },
      heldCoins: () => this.store.heldCoins(),
      unfinishedEvm: () => this.store.unfinishedEvm(),
    };
  }

  /** The vault's own address on the chain an asset leaves from, which is where refunds go. */
  private async ownAddress(asset: SwapOrigin): Promise<string> {
    if (asset === "BTC") return this.world.btcAddress();
    if (asset === "SOL") return this.world.solAddress();
    // ETH and USDC both leave from the vault's Base address.
    return this.world.evmAddress();
  }

  /** The Tidepool asset a swap delivers, and its recipient, with a swap payee's label resolved. */
  private async swapTarget(request: PayRequest): Promise<{ token: Token; recipient: string; timing: Timing }> {
    const timing = await this.world.vault.timing();
    if (!timing.swap) throw new Error("this vault's policy has no swap section, so it refuses swaps");
    const chain = tidepoolChain(request.toChain ?? "base");
    const token = await this.tidepool.token(chain, request.toAsset ?? request.asset);
    const label = request.to.trim().toLowerCase();
    const payee = timing.swap.payees.find(
      (p) => p.destination_asset === token.assetId && p.label.toLowerCase() === label,
    );
    return { token, recipient: payee?.recipient ?? request.to.trim(), timing };
  }

  private async paySwap(request: PayRequest): Promise<Payment> {
    const { asset, amount, reference } = request;
    if (!(asset in TIDEPOOL.origins)) throw new Error(`${asset} can't be swapped from; use BTC, ETH, USDC or SOL`);
    const origin = asset as SwapOrigin;
    const { token, recipient, timing } = await this.swapTarget(request);
    const key = keyOf(this.options.vault, reference);
    const description = `${amount} ${asset} as ${token.symbol} on ${token.blockchain} to ${recipient}: ${reference}`;
    const result = await this.payer.spend(key, description, async () => {
      const { signed, terms } = await this.tidepool.quote({
        dry: false,
        origin: TIDEPOOL.origins[origin],
        destination: token.assetId,
        amount,
        refundTo: await this.ownAddress(origin),
        recipient,
        deadline: quoteDeadline(timing, Date.now()),
        ...(timing.swap ? { slippageBps: Math.min(100, timing.swap.max_slippage_bps) } : {}),
      });
      const prepared = await preparePayment(this.swapDeps(), asset, terms.depositAddress, BigInt(terms.amountIn));
      return { ...prepared, quote: signed, swap: terms };
    });
    return this.afterSwapBroadcast(key, result);
  }

  /** Tells Tidepool about a swap's deposit once it's broadcast. Tidepool finds it anyway, so this is best effort. */
  private async afterSwapBroadcast(key: string, result: Payment): Promise<Payment> {
    const record = this.store.get(key);
    if (!record?.prepared.swap || result.status !== "broadcast" || !record.chainTx || record.swapStatus) {
      return result;
    }
    await this.tidepool.submitDeposit(record.chainTx, record.prepared.swap.depositAddress).catch(() => undefined);
    return this.refreshSwap(key).catch(() => result);
  }

  /**
   * A swap's progress from Tidepool: `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS` (delivered),
   * `REFUNDED` (returned to the vault) or `FAILED`.
   */
  async swapStatus(paymentReference: string): Promise<Payment> {
    const key = keyOf(this.options.vault, paymentReference);
    const record = this.store.get(key);
    if (!record) throw new Error(`no payment with reference "${paymentReference}"`);
    if (!record.prepared.swap) throw new Error(`"${paymentReference}" isn't a swap`);
    return this.refreshSwap(key);
  }

  private async refreshSwap(key: string): Promise<Payment> {
    const record = this.store.get(key);
    if (!record?.prepared.swap) throw new Error("no swap on record");
    const swapStatus = await this.tidepool.status(record.prepared.swap.depositAddress);
    const updated = { ...record, swapStatus };
    this.store.put(updated);
    return report(updated);
  }

  /** A swap's expected output, without spending anything or reserving a deposit address. */
  async quoteSwap(request: Omit<PayRequest, "reference">): Promise<{ amountIn: string; amountOut: string; minAmountOut: string; asset: string }> {
    const { asset, amount } = request;
    if (!(asset in TIDEPOOL.origins)) throw new Error(`${asset} can't be swapped from; use BTC, ETH, USDC or SOL`);
    const origin = asset as SwapOrigin;
    const { token, recipient, timing } = await this.swapTarget({ ...request, reference: "quote" });
    const { terms, amountOut } = await this.tidepool.quote({
      dry: true,
      origin: TIDEPOOL.origins[origin],
      destination: token.assetId,
      amount,
      refundTo: await this.ownAddress(origin),
      recipient,
      deadline: quoteDeadline(timing, Date.now()),
    });
    return { amountIn: terms.amountIn, amountOut, minAmountOut: terms.minAmountOut, asset: token.assetId };
  }

  /** The tokens a swap may deliver under the vault's policy. */
  async destinations(): Promise<Token[]> {
    const timing = await this.world.vault.timing();
    const allowed = new Set(timing.swap?.destinations ?? []);
    return (await this.tidepool.tokens()).filter((token) => allowed.has(token.assetId));
  }

  /** Who the vault may pay. Everything else is refused. */
  async payees(): Promise<Payee[]> {
    return (await this.world.vault.payees()).map((payee) => ({
      label: payee.label,
      chain: payee.chain,
      address: payeeAddress(payee),
    }));
  }

  /** Payments waiting out the veto window. */
  queue(): Promise<QueuedSpend[]> {
    return this.world.vault.queue();
  }

  /** The vault's own addresses, to fund it. */
  async addresses(): Promise<{ bitcoin: string; evm: string; solana?: string }> {
    const solana = await this.world.solAddress().catch(() => undefined);
    return {
      bitcoin: await this.world.btcAddress(),
      evm: await this.world.evmAddress(),
      ...(solana ? { solana } : {}),
    };
  }

  async balances(): Promise<Balances> {
    const { vault, reads, chain, usdc } = this.world;
    const [btc, eth, token, btcSpent, ethSpent, usdcSpent] = await Promise.all([
      reads.btcBalance(),
      reads.ethBalance(),
      reads.tokenBalance(),
      vault.spent24h("Btc"),
      vault.spent24h({ EvmNative: { chain_id: chain.chainId } }),
      vault.spent24h({ Erc20: { chain_id: chain.chainId, token: [...hexToBytes(usdc)] } }),
    ]);
    const balances: Balances = {
      BTC: { balance: btc, spent24h: BigInt(btcSpent) },
      ETH: { balance: eth, spent24h: BigInt(ethSpent) },
      USDC: { balance: token, spent24h: BigInt(usdcSpent) },
    };
    if (!(await this.world.solAddress().catch(() => undefined))) return balances;
    const mint = [...base58.decode(this.options.solUsdcMint ?? TESTNET.solUsdcMint)];
    const [sol, solToken, solSpent, solTokenSpent] = await Promise.all([
      reads.solBalance(),
      reads.solTokenBalance(),
      vault.spent24h("Sol"),
      vault.spent24h({ Spl: { mint } }),
    ]);
    return {
      ...balances,
      SOL: { balance: sol, spent24h: BigInt(solSpent) },
      "USDC-SOL": { balance: solToken, spent24h: BigInt(solTokenSpent) },
    };
  }
}

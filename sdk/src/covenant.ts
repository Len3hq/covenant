import { hexToBytes } from "viem";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { jsonLog, type Log } from "./log.js";
import { Payer, type SpendReport } from "./payer.js";
import { payeeAddress, preparePayment, resolvePayee, type Asset } from "./payments.js";
import { SpendStore } from "./store.js";
import { connectTestnet, type ConnectOptions } from "./testnet.js";
import type { QueuedSpend } from "./vault.js";

export interface CovenantOptions extends ConnectOptions {
  /**
   * Where each payment's progress is written before every step, so a crash or retry never pays
   * twice. Keep it on storage that survives restarts. Defaults to `covenant-spends.json`.
   */
  spendsFile?: string;
  /** Receives each step as it happens. Defaults to JSON lines on stderr; pass `() => {}` to silence. */
  log?: Log;
}

export interface PayRequest {
  asset: Asset;
  /** A payee's label from the vault's policy, or an address. */
  to: string;
  /** Whole base units: sats for BTC, wei for ETH, and 1_000_000n is 1 USDC. */
  amount: bigint;
  /**
   * What this payment is for, such as an invoice number. The same reference never pays twice: a
   * second call returns the first one's result, or finishes it if it was interrupted.
   */
  reference: string;
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

  private constructor(
    private readonly options: CovenantOptions,
    private readonly world: ReturnType<typeof connectTestnet>,
  ) {
    this.store = new SpendStore(options.spendsFile ?? "covenant-spends.json");
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
    const destination = await resolvePayee(this.world.vault, request.to, asset);
    return this.payer.spend(keyOf(this.options.vault, reference), `${amount} ${asset} to ${destination}: ${reference}`, () =>
      preparePayment({ ...this.world, bitcoin: this.world, heldCoins: () => this.store.heldCoins() }, asset, destination, amount),
    );
  }

  /** Signs and broadcasts a queued payment whose veto window has passed. */
  execute(id: string): Promise<Payment> {
    return this.payer.execute(id);
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
  async addresses(): Promise<{ bitcoin: string; evm: string }> {
    return { bitcoin: await this.world.btcAddress(), evm: await this.world.evmAddress() };
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
    return {
      BTC: { balance: btc, spent24h: BigInt(btcSpent) },
      ETH: { balance: eth, spent24h: BigInt(ethSpent) },
      USDC: { balance: token, spent24h: BigInt(usdcSpent) },
    };
  }
}

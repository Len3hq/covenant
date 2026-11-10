import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { z } from "zod";
import { withRetry } from "./retry.js";

/**
 * Tidepool, a testnet copy of NEAR Intents' 1Click API. The vault checks every quote itself; this
 * client checks it first too, so a quote the vault would refuse never costs NEAR gas.
 */
export const TIDEPOOL = {
  baseUrl: "https://www.usetidepool.tech",
  /** The maker key on `maker.tidepool-sandbox.testnet`, read on 10 Nov 2026. */
  makerKey: "ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY",
  /** Tidepool's ids for what the vault can pay from. `USDC` is Tidepool's USDC on Base. */
  origins: {
    BTC: "nep141:btc.tp-omft.testnet",
    ETH: "nep141:base.tp-omft.testnet",
    USDC: "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
    SOL: "nep141:sol.tp-omft.testnet",
  },
} as const;

export type SwapOrigin = keyof typeof TIDEPOOL.origins;

/** What the vault's `propose_spend` takes: the exact signed JSON, base64, and its signature. */
export interface SignedQuote {
  body: string;
  signature: string;
}

/** The terms a quote commits to, kept with the spend so its status can be followed. */
export interface SwapTerms {
  correlationId: string;
  depositAddress: string;
  destinationAsset: string;
  recipient: string;
  amountIn: string;
  minAmountOut: string;
  deadline: string;
}

const tokenSchema = z.object({
  assetId: z.string(),
  decimals: z.number(),
  blockchain: z.string(),
  symbol: z.string(),
});
export type Token = z.infer<typeof tokenSchema>;

const quoteSchema = z.object({
  correlationId: z.string(),
  timestamp: z.string(),
  quoteRequest: z.record(z.string(), z.unknown()),
  quote: z.object({
    depositAddress: z.string().optional(),
    amountIn: z.string(),
    amountOut: z.string(),
    minAmountOut: z.string(),
    deadline: z.string().optional(),
  }).passthrough(),
  signature: z.string(),
});

const statusSchema = z.object({ status: z.string() }).passthrough();

export interface QuoteRequest {
  dry: boolean;
  origin: string;
  destination: string;
  /** Base units of the origin asset. */
  amount: bigint;
  refundTo: string;
  recipient: string;
  deadline: Date;
  slippageBps?: number;
}

/** The bytes Tidepool signs: the response without its signature, in the order it was sent. */
export function signedBody(response: Record<string, unknown>): string {
  const { correlationId, timestamp, quoteRequest, quote } = response;
  return JSON.stringify({ correlationId, timestamp, quoteRequest, quote });
}

/** Whether `signature` is the maker's Ed25519 signature over `sha256(body)`. */
export function quoteSignedBy(body: string, signature: string, makerKey: string): boolean {
  const decode = (text: string) => base58.decode(text.replace(/^ed25519:/, ""));
  try {
    return ed25519.verify(decode(signature), sha256(new TextEncoder().encode(body)), decode(makerKey));
  } catch {
    return false;
  }
}

export class Tidepool {
  constructor(
    private readonly baseUrl: string = TIDEPOOL.baseUrl,
    private readonly makerKey: string = TIDEPOOL.makerKey,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Retries only what may pass next time: network errors and server errors, never a refusal. */
  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const { status, text } = await withRetry(async () => {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      const answer = { status: response.status, text: await response.text() };
      if (answer.status >= 500) throw new Error(`Tidepool ${path} answered ${answer.status}: ${answer.text}`);
      return answer;
    });
    if (status >= 400) throw new Error(`Tidepool ${path} answered ${status}: ${text}`);
    return JSON.parse(text) as unknown;
  }

  async tokens(): Promise<Token[]> {
    return z.array(tokenSchema).parse(await this.call("/v0/tokens"));
  }

  /** A token by chain and symbol, such as `sol` and `USDC`. */
  async token(blockchain: string, symbol: string): Promise<Token> {
    const found = (await this.tokens()).find(
      (token) => token.blockchain === blockchain.toLowerCase() && token.symbol.toUpperCase() === symbol.toUpperCase(),
    );
    if (!found) throw new Error(`Tidepool has no ${symbol} on ${blockchain}`);
    return found;
  }

  /**
   * Asks for a quote. A live one is checked against the maker key and returned with the exact
   * bytes its signature covers, ready for `propose_spend`.
   */
  async quote(request: QuoteRequest): Promise<{ signed: SignedQuote; terms: SwapTerms; amountOut: string }> {
    const raw = await this.call("/v0/quote", {
      method: "POST",
      body: JSON.stringify({
        dry: request.dry,
        swapType: "EXACT_INPUT",
        slippageTolerance: request.slippageBps ?? 100,
        originAsset: request.origin,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: request.destination,
        amount: request.amount.toString(),
        refundTo: request.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: request.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: request.deadline.toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
    });
    const parsed = quoteSchema.parse(raw);
    const body = signedBody(raw as Record<string, unknown>);
    if (!quoteSignedBy(body, parsed.signature, this.makerKey)) {
      throw new Error("Tidepool's quote isn't signed by the maker key, so the vault would refuse it");
    }
    const { quote } = parsed;
    if (!request.dry && (!quote.depositAddress || !quote.deadline)) {
      throw new Error("Tidepool's live quote has no deposit address");
    }
    return {
      signed: { body: Buffer.from(body).toString("base64"), signature: parsed.signature },
      terms: {
        correlationId: parsed.correlationId,
        depositAddress: quote.depositAddress ?? "",
        destinationAsset: request.destination,
        recipient: request.recipient,
        amountIn: quote.amountIn,
        minAmountOut: quote.minAmountOut,
        deadline: quote.deadline ?? "",
      },
      amountOut: quote.amountOut,
    };
  }

  /** Tells Tidepool the deposit was sent, which speeds it up. Tidepool also finds it on its own. */
  async submitDeposit(txHash: string, depositAddress: string): Promise<void> {
    await this.call("/v0/deposit/submit", {
      method: "POST",
      body: JSON.stringify({ txHash, depositAddress }),
    });
  }

  /** `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`, `FAILED` and so on. */
  async status(depositAddress: string): Promise<string> {
    const raw = await this.call(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
    return statusSchema.parse(raw).status;
  }
}

export const statusLink = (depositAddress: string) =>
  `${TIDEPOOL.baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { quoteDeadline, tidepoolChain } from "./covenant.js";
import { quoteSignedBy, signedBody, Tidepool, TIDEPOOL } from "./tidepool.js";

/** A live Tidepool quote from 10 Nov 2026, as the vault's tests also use it. */
const vector = JSON.parse(
  readFileSync(new URL("../../tests/vectors/tidepool_quote.json", import.meta.url), "utf8"),
) as {
  body: string;
  signature: string;
  maker_key: string;
  deposit_address: string;
  recipient: string;
  response: Record<string, unknown>;
};

/** The response Tidepool sent, with its signature. */
const response = { ...vector.response, signature: vector.signature };

describe("quote signatures", () => {
  it("rebuilds the exact bytes Tidepool signed", () => {
    expect(signedBody(response)).toBe(vector.body);
    expect(Object.keys(JSON.parse(vector.body) as object)).toEqual(Object.keys(JSON.parse(vector.body) as object).sort());
    expect(quoteSignedBy(vector.body, vector.signature, TIDEPOOL.makerKey)).toBe(true);
    expect(vector.maker_key).toBe(TIDEPOOL.makerKey);
  });

  it("signs a dry quote's amounts only, and drops the optional request fields when empty", () => {
    const dry = {
      timestamp: "t",
      quoteRequest: { dry: true, amount: "1", referral: "", deadline: "d" },
      quote: { amountIn: "1", minAmountOut: "0", depositAddress: "x", deadline: "q" },
    };
    expect(signedBody(dry)).toBe('{"amount":"1","amountIn":"1","deadline":"d","dry":true,"minAmountOut":"0","timestamp":"t"}');
    const live = { ...dry, quoteRequest: { ...dry.quoteRequest, dry: false } };
    expect(JSON.parse(signedBody(live))).toMatchObject({ deadline: "q", depositAddress: "x", dry: false });
  });

  it("refuses a changed body or another key", () => {
    const changed = vector.body.replace(vector.recipient, "0x00000000000000000000000000000000000000bb");
    expect(quoteSignedBy(changed, vector.signature, TIDEPOOL.makerKey)).toBe(false);
    expect(quoteSignedBy(vector.body, vector.signature, "ed25519:11111111111111111111111111111111")).toBe(false);
    expect(quoteSignedBy(vector.body, "ed25519:abc", TIDEPOOL.makerKey)).toBe(false);
  });
});

describe("Tidepool.quote", () => {
  const fetcher = (answer: unknown) =>
    (async () => new Response(JSON.stringify(answer), { status: 200 })) as unknown as typeof fetch;
  const request = {
    dry: false,
    origin: TIDEPOOL.origins.BTC,
    destination: "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
    amount: 20_000n,
    refundTo: "tb1q2xq57yyxwzkw6tthcxq9mhtxxj7f63e3dgldfj",
    recipient: vector.recipient,
    deadline: new Date("2026-11-11T16:00:00Z"),
  };

  it("returns the signed bytes the vault checks, and the swap's terms", async () => {
    const tidepool = new Tidepool(TIDEPOOL.baseUrl, TIDEPOOL.makerKey, fetcher(response));
    const { signed, terms } = await tidepool.quote(request);
    expect(Buffer.from(signed.body, "base64").toString()).toBe(vector.body);
    expect(signed.signature).toBe(vector.signature);
    expect(terms.depositAddress).toBe(vector.deposit_address);
    expect(terms.amountIn).toBe("20000");
  });

  it("refuses a quote the maker didn't sign, before any NEAR gas is spent", async () => {
    const forged = { ...response, quote: { ...(response.quote as object), amountOut: "1" } };
    const tidepool = new Tidepool(TIDEPOOL.baseUrl, TIDEPOOL.makerKey, fetcher(forged));
    await expect(tidepool.quote(request)).rejects.toThrow("isn't signed by the maker key");
  });
});

describe("quoteDeadline", () => {
  const now = Date.UTC(2026, 10, 10);
  const hours = (date: Date) => (date.getTime() - now) / 3_600_000;

  it("covers the longest veto window and the deposit window, within a day", () => {
    const swap = { min_deposit_window_ns: 3_600_000_000_000 } as never;
    expect(hours(quoteDeadline({ veto_delay_ns: 120_000_000_000, swap }, now))).toBeCloseTo(2.03, 1);
    const long = { veto_delay_ns: 0, unlisted_veto_delay_ns: 48 * 3_600_000_000_000, swap };
    expect(hours(quoteDeadline(long, now))).toBe(23);
    expect(hours(quoteDeadline({ veto_delay_ns: 0 }, now))).toBe(2);
  });
});

describe("tidepoolChain", () => {
  it("accepts Tidepool's names and the common ones", () => {
    expect(tidepoolChain("Solana")).toBe("sol");
    expect(tidepoolChain("bitcoin")).toBe("btc");
    expect(tidepoolChain("base")).toBe("base");
    expect(() => tidepoolChain("dogecoin")).toThrow("unknown chain");
  });
});

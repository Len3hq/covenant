import { describe, expect, it, vi } from "vitest";
import { FAUCET_LINKS, requestTestTokens, TIDEPOOL_FAUCET } from "./faucet";

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("requestTestTokens", () => {
  it("asks Tidepool to drip to the vault's address on that chain", async () => {
    const fetcher = answer(200, { ok: true });
    const result = await requestTestTokens("base", "0xd913a8c28efdb2f30563e063b5fac5abd6ec9361", fetcher);
    expect(result).toEqual({ ok: true, message: "Sent 100 test USDC and 100 test USDT to the vault on Base Sepolia." });
    expect(fetcher).toHaveBeenCalledWith(TIDEPOOL_FAUCET, expect.objectContaining({ method: "POST" }));
    const init = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ chain: "base", address: "0xd913a8c28efdb2f30563e063b5fac5abd6ec9361" });
  });

  it("passes on Tidepool's reason when it refuses", async () => {
    const result = await requestTestTokens("sol", "abc", answer(429, { message: "one claim every 7 days" }));
    expect(result).toEqual({ ok: false, message: "Tidepool didn't send any: one claim every 7 days" });
  });

  it("lists a faucet for every coin the vault needs", () => {
    const coins = FAUCET_LINKS.map((link) => link.coin).join(" ");
    for (const coin of ["BTC", "ETH", "SOL", "NEAR", "USDC"]) expect(coins).toContain(coin);
  });
});

import vector from "../../tests/vectors/grant.json";
import { describe, expect, it, vi } from "vitest";
import { grantExpiry, grantMessage, hostedPublicKey, submitGrant } from "./hosted";

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("hosted grants", () => {
  it("writes the message the enclave and the connector read", () => {
    expect(grantMessage(vector.terms)).toBe(vector.grant.message);
  });

  it("expires a whole number of days from now", () => {
    expect(grantExpiry(30, 1_000_000)).toBe(1000 + 30 * 86_400);
  });

  it("gets the enclave's key, and refuses an answer without one", async () => {
    expect(await hostedPublicKey("https://c", answer(200, { public_key: "ed25519:abc" }))).toBe("ed25519:abc");
    await expect(hostedPublicKey("https://c", answer(502, { error: "OutLayer is down" }))).rejects.toThrow("OutLayer is down");
  });

  it("hands over the grant and returns where Claude waits, or the connector's reason", async () => {
    const grant = { message: "m", nonce: "n", public_key: "ed25519:k", signature: "s" };
    expect(await submitGrant("https://c", "r1", grant, answer(200, { redirect: "https://claude.ai/cb?code=x" }))).toBe(
      "https://claude.ai/cb?code=x",
    );
    await expect(submitGrant("https://c", "r1", grant, answer(400, { error: "the grant has expired" }))).rejects.toThrow(
      "the grant has expired",
    );
  });
});

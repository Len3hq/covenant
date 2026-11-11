import { describe, expect, it, vi } from "vitest";
import { outlayerKeyHolder } from "./keyholder.js";

const answering = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const options = { apiUrl: "https://api.outlayer.ai", project: "realist1036.near/covenant-key-holder", paymentKey: "k" };
const grant = { message: "m", nonce: "n", public_key: "ed25519:x", signature: "s" };
const call = {
  signerId: "a", publicKey: "ed25519:x", nonce: "1", receiverId: "v", blockHash: "h", method: "execute", args: "", gas: "1",
};

describe("outlayerKeyHolder", () => {
  it("calls the project with the payment key and reads the enclave's output", async () => {
    const fetcher = answering(200, { status: "completed", output: '{"public_key":"ed25519:abc"}' });
    expect(await outlayerKeyHolder({ ...options, fetcher }).publicKey()).toBe("ed25519:abc");
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0] ?? [];
    expect(url).toBe("https://api.outlayer.ai/call/realist1036.near/covenant-key-holder");
    expect(new Headers(init?.headers).get("x-payment-key")).toBe("k");
    expect(JSON.parse(String(init?.body))).toEqual({ input: { operation: "public_key" } });
  });

  it("returns the signature, and passes on a refusal", async () => {
    const signature = Buffer.alloc(64, 1).toString("base64");
    const signer = outlayerKeyHolder({ ...options, fetcher: answering(200, { status: "completed", output: { signature } }) }).signer(grant, "ed25519:x");
    expect(Buffer.from(await signer.sign(call))).toEqual(Buffer.alloc(64, 1));
    const refusing = outlayerKeyHolder({ ...options, fetcher: answering(200, { status: "completed", output: { error: "the grant has expired" } }) });
    await expect(refusing.signer(grant, "ed25519:x").sign(call)).rejects.toThrow("refused: the grant has expired");
    const broke = outlayerKeyHolder({ ...options, fetcher: answering(402, { error: "insufficient balance" }) });
    await expect(broke.publicKey()).rejects.toThrow("402");
  });
});

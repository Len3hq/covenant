import { describe, expect, it, vi } from "vitest";
import { outlayerKeyHolder, withKnownPublicKey } from "./keyholder.js";

const answering = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const options = { apiUrl: "https://testnet-api.outlayer.ai", project: "keyholder.len3hq.testnet/covenant-key-holder", paymentKey: "k" };
const grant = { message: "m", nonce: "n", public_key: "ed25519:x", signature: "s" };
const call = {
  signerId: "a", publicKey: "ed25519:x", nonce: "1", receiverId: "v", blockHash: "h", method: "execute", args: "", gas: "1",
};

describe("outlayerKeyHolder", () => {
  it("calls the project with the payment key and reads the enclave's output", async () => {
    const fetcher = answering(200, { status: "completed", output: '{"public_key":"ed25519:abc"}' });
    expect(await outlayerKeyHolder({ ...options, fetcher }).publicKey()).toBe("ed25519:abc");
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0] ?? [];
    expect(url).toBe("https://testnet-api.outlayer.ai/call/keyholder.len3hq.testnet/covenant-key-holder");
    expect(new Headers(init?.headers).get("x-payment-key")).toBe("k");
    expect(JSON.parse(String(init?.body))).toEqual({ input: { operation: "public_key" } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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

describe("withKnownPublicKey", () => {
  const KEY = "ed25519:8rPY7UqToQA4QTWpe7pWGTWT5aMxFbPcaRWuqStWY56z";
  const enclave = (publicKey: () => Promise<string>) => ({ publicKey: vi.fn(publicKey), signer: vi.fn() });
  const missing = () => {
    throw new Error("no file");
  };

  it("answers from the setting without asking the enclave", async () => {
    const holder = enclave(async () => "ed25519:other");
    expect(await withKnownPublicKey(holder, { known: KEY, file: "f", read: missing }).publicKey()).toBe(KEY);
    expect(holder.publicKey).not.toHaveBeenCalled();
  });

  it("answers from the saved file after a restart", async () => {
    const holder = enclave(async () => "ed25519:other");
    expect(await withKnownPublicKey(holder, { file: "f", read: () => `${KEY}\n` }).publicKey()).toBe(KEY);
    expect(holder.publicKey).not.toHaveBeenCalled();
  });

  it("asks the enclave once, saves the answer, and asks again after a failure", async () => {
    const write = vi.fn();
    let fail = true;
    const holder = enclave(async () => {
      if (fail) throw new Error("the key holder didn't answer (524)");
      return KEY;
    });
    const known = withKnownPublicKey(holder, { file: "f", read: missing, write });
    await expect(known.publicKey()).rejects.toThrow("524");
    fail = false;
    expect(await known.publicKey()).toBe(KEY);
    expect(await known.publicKey()).toBe(KEY);
    expect(holder.publicKey).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith("f", KEY);
  });

  it("ignores a setting that isn't a key", async () => {
    const holder = enclave(async () => KEY);
    expect(await withKnownPublicKey(holder, { known: "nonsense", file: "f", read: missing, write: vi.fn() }).publicKey()).toBe(KEY);
    expect(holder.publicKey).toHaveBeenCalledOnce();
  });
});

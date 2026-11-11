import { sha256 } from "@noble/hashes/sha2.js";
import { actions, createTransaction, encodeTransaction, KeyPair, PublicKey, type KeyPairString } from "near-api-js";
import { describe, expect, it } from "vitest";
import { agentCall, localRemoteSigner, RemoteNearSigner, transactionFromCall, type RemoteSigner } from "./signer.js";

const secret = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
const key = KeyPair.fromString(secret);
const call = (method = "propose_spend", deposit = 0n, extra: ReturnType<typeof actions.transfer>[] = []) =>
  createTransaction(
    "agent.alice.testnet",
    key.getPublicKey(),
    "alice.vaults-v3.len3hq.testnet",
    42n,
    [actions.functionCall(method, { request: { Bitcoin: {} } }, 300_000_000_000_000n, deposit), ...extra],
    new Uint8Array(32).fill(7),
  );

describe("RemoteNearSigner", () => {
  it("signs a vault call with the remote key, as a local key would", async () => {
    const signer = new RemoteNearSigner(localRemoteSigner(secret));
    const { txHash, signedTransaction } = await signer.signTransaction(call());
    expect(txHash).toEqual(sha256(encodeTransaction(call())));
    expect(key.verify(txHash, signedTransaction.signature.data)).toBe(true);
    expect((await signer.getPublicKey()).toString()).toBe(key.getPublicKey().toString());
  });

  it("refuses anything but one no-deposit call to propose_spend or execute", async () => {
    const signer = new RemoteNearSigner(localRemoteSigner(secret));
    await expect(signer.signTransaction(call("set_policy"))).rejects.toThrow("may not call set_policy");
    await expect(signer.signTransaction(call("execute", 1n))).rejects.toThrow("no deposit");
    await expect(signer.signTransaction(call("execute", 0n, [actions.transfer(1n)]))).rejects.toThrow("exactly one");
    await expect(signer.signNep413Message()).rejects.toThrow("only vault calls");
  });

  it("catches a remote signer that signed something else", async () => {
    const liar: RemoteSigner = {
      publicKey: key.getPublicKey().toString(),
      sign: async () => key.sign(sha256(new TextEncoder().encode("something else"))).signature,
    };
    await expect(new RemoteNearSigner(liar).signTransaction(call())).rejects.toThrow("doesn't match");
  });
});

describe("transactionFromCall", () => {
  it("rebuilds the exact transaction from its fields", () => {
    expect(encodeTransaction(transactionFromCall(agentCall(call())))).toEqual(encodeTransaction(call()));
  });

  it("refuses a call for another key or method", async () => {
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    await expect(localRemoteSigner(secret).sign({ ...agentCall(call()), publicKey: other })).rejects.toThrow("another key");
    expect(() => transactionFromCall({ ...agentCall(call()), method: "set_agent" })).toThrow("may not call");
    expect(PublicKey.fromString(agentCall(call()).publicKey).toString()).toBe(key.getPublicKey().toString());
  });
});

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  accountExists,
  addAgentKeyTransaction,
  agentAccountId,
  AGENT_METHODS,
  createAgentTransaction,
  newAgentKey,
} from "./agent";

describe("newAgentKey", () => {
  it("writes the secret as NEAR does: the seed, then the public key", () => {
    const key = newAgentKey(new Uint8Array(32).fill(7));
    const both = base58.decode(key.secretKey.replace("ed25519:", ""));
    expect(both).toHaveLength(64);
    expect(base58.encode(both.slice(32))).toBe(key.publicKey.replace("ed25519:", ""));
    expect(ed25519.getPublicKey(both.slice(0, 32))).toEqual(both.slice(32));
  });

  it("makes a different key each time", () => {
    expect(newAgentKey().publicKey).not.toBe(newAgentKey().publicKey);
  });
});

describe("agentAccountId", () => {
  it("is a subaccount of the owner's", () => {
    expect(agentAccountId(" Bot ", "alice.testnet")).toBe("bot.alice.testnet");
    expect(() => agentAccountId("my.bot", "alice.testnet")).toThrow("no dots");
    expect(() => agentAccountId("bot", "a".repeat(64))).toThrow("has no name");
    expect(() => agentAccountId("b".repeat(60), "alice.testnet")).toThrow("64-character");
  });
});

describe("agent transactions", () => {
  it("creates, funds and keys the account in one transaction, scoped to the vault", () => {
    const tx = createAgentTransaction("bot.alice.testnet", "acme.vaults.testnet", "ed25519:KEY");
    expect(tx.receiverId).toBe("bot.alice.testnet");
    expect(tx.actions.map((action) => action.type)).toEqual(["CreateAccount", "Transfer", "AddKey"]);
    const addKey = tx.actions[2];
    expect(addKey).toEqual({
      type: "AddKey",
      params: {
        publicKey: "ed25519:KEY",
        accessKey: {
          permission: {
            receiverId: "acme.vaults.testnet",
            allowance: "1000000000000000000000000",
            methodNames: AGENT_METHODS,
          },
        },
      },
    });
    expect(JSON.stringify(tx)).not.toContain("FullAccess");
  });

  it("adds only the scoped key to an account that already exists", () => {
    const tx = addAgentKeyTransaction("bot.testnet", "acme.vaults.testnet", "ed25519:KEY");
    expect(tx.actions.map((action) => action.type)).toEqual(["AddKey"]);
  });
});

describe("accountExists", () => {
  const rpc = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  it("reads NEAR's answer", async () => {
    expect(await accountExists("rpc", "a.testnet", rpc({ result: { amount: "1" } }))).toBe(true);
    expect(await accountExists("rpc", "a.testnet", rpc({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }))).toBe(false);
    await expect(accountExists("rpc", "a.testnet", rpc({ error: {} }))).rejects.toThrow("Couldn't check");
  });
});

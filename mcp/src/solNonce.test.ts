import { solanaKeypair, solanaSecret } from "@len3hq/covenant-sdk";
import { base58, base64 } from "@scure/base";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { funderFile, loadFunder, runSolNonce } from "./solNonce.js";

const VAULT = "acme.vaults-v3.len3hq.testnet";
const AUTHORITY = solanaKeypair(new Uint8Array(32).fill(7)).publicKey;
const RENT = 1_447_680;

/** Answers the NEAR view and the Solana calls the command makes, and records what it sends. */
function chains(balance: number, sent: string[] = []): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    switch (body.method) {
      case "query": {
        const view = new TextEncoder().encode(JSON.stringify({ sol_address: base58.encode(AUTHORITY) }));
        return answer({ result: [...view] });
      }
      case "getMinimumBalanceForRentExemption":
        return answer(RENT);
      case "getBalance":
        return answer({ value: balance });
      case "getLatestBlockhash":
        return answer({ value: { blockhash: base58.encode(new Uint8Array(32).fill(5)) } });
      case "sendTransaction":
        sent.push(body.params[0] as string);
        return answer("5ig");
      case "getSignatureStatuses":
        return answer({ value: [{ err: null, confirmationStatus: "confirmed" }] });
      default:
        throw new Error(`unexpected ${body.method}`);
    }
  }) as typeof fetch;
}

const home = () => mkdtempSync(join(tmpdir(), "covenant-sol-nonce-"));

describe("covenant-mcp sol-nonce", () => {
  it("makes a funder once, private to this user, and reuses it", () => {
    const dir = home();
    const first = loadFunder({}, dir);
    expect(first.created).toBe(true);
    expect(statSync(funderFile(dir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(funderFile(dir), "utf8"))).toHaveLength(64);
    const again = loadFunder({}, dir);
    expect(again.created).toBe(false);
    expect(again.funder).toEqual(first.funder);
  });

  it("prefers SOL_FUNDER_KEY, as the repo's scripts write it", () => {
    const funder = solanaKeypair(new Uint8Array(32).fill(3));
    expect(loadFunder({ SOL_FUNDER_KEY: base58.encode(solanaSecret(funder)) }, home()).funder).toEqual(funder);
  });

  it("asks for devnet SOL, and sends nothing, when the funder is short", async () => {
    const lines: string[] = [];
    const sent: string[] = [];
    const code = await runSolNonce({ env: { VAULT_ACCOUNT_ID: VAULT }, home: home(), fetcher: chains(0, sent), log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(sent).toEqual([]);
    expect(lines.join("\n")).toMatch(/holds 0 SOL and needs 0\.00146768 SOL/);
    expect(lines.join("\n")).toContain("faucet.solana.com");
  });

  it("creates the account with the vault as authority, and adds it to the list", async () => {
    const lines: string[] = [];
    const sent: string[] = [];
    const code = await runSolNonce({
      env: { VAULT_ACCOUNT_ID: VAULT, SOL_NONCE_ACCOUNTS: "Old1111" },
      home: home(),
      fetcher: chains(RENT + 20_000, sent),
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    const message = base64.decode(sent[0] as string).slice(129);
    // The initialize instruction's last 32 bytes name the authority: the vault's Solana address.
    expect([...message.slice(-32)]).toEqual([...AUTHORITY]);
    const created = base58.encode(message.slice(4 + 32, 4 + 64));
    expect(lines).toContain(`SOL_NONCE_ACCOUNTS=Old1111,${created}`);
  });

  it("refuses a mainnet vault and a missing one", async () => {
    const log = () => {};
    expect(await runSolNonce({ env: {}, home: home(), fetcher: chains(0), log })).toBe(1);
    expect(await runSolNonce({ env: { VAULT_ACCOUNT_ID: "acme.near" }, home: home(), fetcher: chains(0), log })).toBe(1);
  });
});

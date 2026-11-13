import { sha256 } from "@noble/hashes/sha2.js";
import { KeyPair, type KeyPairString } from "near-api-js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Wallet } from "@len3hq/covenant-mcp/server";
import { createApp } from "./app.js";
import { ConnectorAuth, Sealer } from "./auth.js";
import { localKeyHolder } from "./keyholder.js";
import { fakeChain, walletGrant } from "./testkit.js";
import type { Terms } from "./grant.js";

const ownerSecret = KeyPair.fromRandom("ed25519").toString();
const ownerKey = KeyPair.fromString(ownerSecret as KeyPairString).getPublicKey().toString();
const agentSecret = KeyPair.fromRandom("ed25519").toString();
const terms: Terms = {
  owner: "frankieme.testnet",
  vault: "frank.vaults-v3.len3hq.testnet",
  agent: "hosted.frankieme.testnet",
  expires: Math.floor(Date.now() / 1000) + 3600,
};
const dashboard = "https://dashboard.example";
const addresses = { bitcoin: "tb1qexample", evm: "0xexample", solana: "SoLexample" };
const wallet = { addresses: async () => addresses } as unknown as Wallet;

let base = "";
let lastVaultParam: string | null = null;
let lastGrantError: string | null = null;
const granted: string[] = [];
let close = () => {};
const opened: string[] = [];

beforeAll(async () => {
  const sealer = new Sealer(new Uint8Array(32).fill(9));
  const app = createApp({
    auth: new ConnectorAuth({ sealer, dashboardUrl: `${dashboard}/`, publicUrl: "http://127.0.0.1" }),
    keyHolder: localKeyHolder(agentSecret),
    chain: fakeChain(terms, ownerKey),
    publicUrl: "http://127.0.0.1",
    dashboardOrigins: [dashboard],
    wallet: (terms) => {
      opened.push(terms.vault);
      return wallet;
    },
    onGrant: (terms) => granted.push(terms.vault),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

/** Registers like Claude does, signs in through the dashboard, and returns the access token. */
async function signIn(resource?: string, signed = terms): Promise<string> {
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Claude", token_endpoint_auth_method: "none" }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };

  const verifier = "a".repeat(64);
  const challenge = Buffer.from(sha256(new TextEncoder().encode(verifier))).toString("base64url");
  const authorize = new URL(`${base}/authorize`);
  for (const [key, value] of Object.entries({
    client_id, redirect_uri: redirectUri, response_type: "code", code_challenge: challenge,
    code_challenge_method: "S256", state: "s1",
  })) authorize.searchParams.set(key, value);
  if (resource) authorize.searchParams.set("resource", resource);
  const sent = await fetch(authorize, { redirect: "manual" });
  const toDashboard = new URL(sent.headers.get("location") ?? "");
  expect(toDashboard.origin).toBe(dashboard);
  const request = toDashboard.searchParams.get("connect") ?? "";
  lastVaultParam = toDashboard.searchParams.get("vault");

  const granted = await fetch(`${base}/grant`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: dashboard },
    body: JSON.stringify({ request, grant: await walletGrant(signed, ownerSecret) }),
  });
  lastGrantError = granted.status === 200 ? null : ((await granted.clone().json()) as { error: string }).error;
  if (lastGrantError) return "";
  expect(granted.status).toBe(200);
  const back = new URL(((await granted.json()) as { redirect: string }).redirect);
  expect(back.origin + back.pathname).toBe(redirectUri);
  expect(back.searchParams.get("state")).toBe("s1");

  const token = await fetch(`${base}/token`, form({
    grant_type: "authorization_code", client_id, code: back.searchParams.get("code") ?? "",
    code_verifier: verifier, redirect_uri: redirectUri,
  }));
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

const rpc = (token: string, method: string, params: object = {}, path = "/mcp") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

const answer = async (response: Response) => {
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text) as { result?: { content?: { text: string }[] } };
};

describe("the hosted connector", () => {
  it("signs in through the owner's grant and serves that vault's tools", async () => {
    const token = await signIn();
    const listed = await answer(await rpc(token, "tools/list"));
    expect(JSON.stringify(listed)).toContain("get_addresses");
    const called = await answer(await rpc(token, "tools/call", { name: "get_addresses", arguments: {} }));
    expect(JSON.parse(called.result?.content?.[0]?.text ?? "{}")).toEqual(addresses);
    expect(opened).toContain(terms.vault);
    expect(granted).toContain(terms.vault);
  });

  it("refuses MCP without a token it made, and grants from anywhere but the dashboard", async () => {
    expect((await rpc("forged.token", "tools/list")).status).toBe(401);
    const unauthenticated = await fetch(`${base}/mcp`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain("resource_metadata");
    const elsewhere = await fetch(`${base}/grant`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ request: "x", grant: await walletGrant(terms, ownerSecret) }),
    });
    expect(elsewhere.status).toBe(403);
  });

  it("refuses a grant the vault's owner didn't sign", async () => {
    const stranger = KeyPair.fromRandom("ed25519").toString();
    const response = await fetch(`${base}/grant`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: dashboard },
      body: JSON.stringify({ request: "x", grant: await walletGrant(terms, stranger) }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("isn't a full-access key");
  });

  it("gives the dashboard the key holder's public key", async () => {
    const response = await fetch(`${base}/public-key`, { headers: { origin: dashboard } });
    expect(((await response.json()) as { public_key: string }).public_key).toBe(
      KeyPair.fromString(agentSecret as KeyPairString).getPublicKey().toString(),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("gives each vault its own address, which signs in straight to that vault", async () => {
    const path = `/v/${terms.vault}/mcp`;
    const token = await signIn(`http://127.0.0.1${path}`);
    expect(lastVaultParam).toBe(terms.vault);
    const called = await answer(await rpc(token, "tools/call", { name: "get_addresses", arguments: {} }, path));
    expect(JSON.parse(called.result?.content?.[0]?.text ?? "{}")).toEqual(addresses);
    const init = await answer(
      await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }, path),
    );
    expect(JSON.stringify(init)).toContain(`one Covenant vault: ${terms.vault}`);
    const elsewhere = await rpc(token, "tools/list", {}, "/v/other.vaults-v3.len3hq.testnet/mcp");
    expect(elsewhere.status).toBe(403);
    expect(((await elsewhere.json()) as { error: { message: string } }).error.message).toContain("this address is for other.vaults-v3");
  });

  it("refuses a grant for another vault on a vault's own sign-in", async () => {
    const other = { ...terms, vault: "other.vaults-v3.len3hq.testnet" };
    await signIn(`http://127.0.0.1/v/${terms.vault}/mcp`, other);
    expect(lastGrantError).toContain(`this sign-in is for ${terms.vault}`);
  });

  it("describes each vault's address for apps to find the sign-in, and rejects what isn't a vault name", async () => {
    const meta = await fetch(`${base}/.well-known/oauth-protected-resource/v/${terms.vault}/mcp`);
    expect(await meta.json()).toMatchObject({ resource: `http://127.0.0.1/v/${terms.vault}/mcp` });
    const unauthenticated = await fetch(`${base}/v/${terms.vault}/mcp`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(`oauth-protected-resource/v/${terms.vault}/mcp`);
    expect((await fetch(`${base}/v/not%20a%20vault/mcp`, { method: "POST" })).status).toBe(404);
  });

  it("lets a web page check the MCP endpoints and read where to sign in", async () => {
    for (const path of ["/mcp", `/v/${terms.vault}/mcp`]) {
      const preflight = await fetch(`${base}${path}`, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
      const challenge = await fetch(`${base}${path}`, { method: "POST", headers: { origin: "https://claude.ai" } });
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("access-control-allow-origin")).toBe("*");
      expect(challenge.headers.get("access-control-expose-headers")).toContain("www-authenticate");
    }
  });
});

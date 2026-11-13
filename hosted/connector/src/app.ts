import express, { type Request, type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type Wallet } from "@len3hq/covenant-mcp/server";
import type { ConnectorAuth } from "./auth.js";
import { checkGrant, grantSchema, parseTerms, type ChainView, type Grant, type Terms } from "./grant.js";
import type { KeyHolder } from "./keyholder.js";
import { isVaultName } from "./vaults.js";

export interface AppOptions {
  auth: ConnectorAuth;
  keyHolder: KeyHolder;
  chain: ChainView;
  publicUrl: string;
  /** The dashboards that may hand over a grant: the hosted one, and any local ones for development. */
  dashboardOrigins: string[];
  /** One wallet per vault, so a vault's spends file has one writer. */
  wallet(terms: Terms, grant: Grant, publicKey: string): Wallet;
  /** Told about each grant that passes its checks, so held payments can be sent later. */
  onGrant?(terms: Terms, grant: Grant): void;
}

/** The connector: OAuth for Claude, the key holder's public key for the dashboard, and the MCP tools. */
export function createApp(options: AppOptions) {
  const app = express();
  // Two RPC reads per check, so a grant that passed is trusted for a minute. The enclave checks it
  // again before every signature, so this only saves time.
  const checked = new Map<string, { terms: Terms; at: number }>();
  const check = async (grant: Grant): Promise<Terms> => {
    const hit = checked.get(grant.signature);
    if (hit && Date.now() - hit.at < 60_000 && hit.terms.expires > Date.now() / 1000) return hit.terms;
    const terms = await checkGrant(grant, options.chain);
    checked.set(grant.signature, { terms, at: Date.now() });
    return terms;
  };
  app.set("trust proxy", 1);
  const issuerUrl = new URL(options.publicUrl);
  const mcpUrl = new URL("/mcp", issuerUrl);

  app.use(
    mcpAuthRouter({
      provider: options.auth,
      issuerUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "Covenant vault",
      serviceDocumentationUrl: new URL("https://github.com/Len3hq/covenant/blob/main/docs/HOSTED.md"),
    }),
  );

  const fromDashboard = (req: Request, res: Response) => {
    const origin = req.headers.origin;
    res.setHeader("vary", "origin");
    if (origin === undefined) return true;
    if (!options.dashboardOrigins.includes(origin)) return false;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type");
    return true;
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /** The access key the owner's wallet gives a new hosted agent. */
  /** Public, so any page may read it. */
  app.get("/public-key", async (_req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    try {
      res.json({ public_key: await options.keyHolder.publicKey() });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  app.options("/grant", (req, res) => {
    fromDashboard(req, res);
    res.sendStatus(204);
  });

  /** The dashboard hands over the grant the owner signed, and gets where to send them next. */
  app.post("/grant", express.json({ limit: "16kb" }), async (req, res) => {
    if (!fromDashboard(req, res)) {
      res.status(403).json({ error: "grants come from the Covenant dashboard" });
      return;
    }
    try {
      const body = req.body as { request?: unknown; grant?: unknown };
      const grant = grantSchema.parse(body.grant);
      // A sign-in through one vault's own address takes a grant for that vault only.
      const expected = options.auth.vaultOfRequest(String(body.request));
      if (expected && parseTerms(grant.message).vault !== expected) {
        throw new Error(`this sign-in is for ${expected}; sign a grant for that vault`);
      }
      options.onGrant?.(await checkGrant(grant, options.chain), grant);
      res.json({ redirect: options.auth.completeSignIn(String(body.request), grant) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** The MCP address of one vault: `/v/<vault>/mcp`. */
  const vaultMcpUrl = (vault: string) => new URL(`/v/${vault}/mcp`, issuerUrl);
  const bearerFor = (url: URL) =>
    requireBearerAuth({ verifier: options.auth, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(url) });
  const sharedBearer = bearerFor(mcpUrl);

  /** Stateless MCP: each request gets a server for the vault its token's grant names. */
  const serveMcp = (vault: string | null) => async (req: Request, res: Response) => {
    try {
      const grant = grantSchema.parse(req.auth?.extra?.grant);
      const terms = await check(grant);
      if (vault !== null && terms.vault !== vault) {
        throw new Error(`this address is for ${vault}, but you signed in for ${terms.vault}; add this vault's own address`);
      }
      options.onGrant?.(terms, grant);
      const wallet = options.wallet(terms, grant, await options.keyHolder.publicKey());
      const server = createServer(wallet);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: error instanceof Error ? error.message : String(error) },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", sharedBearer, express.json({ limit: "1mb" }), serveMcp(null));

  /**
   * One address per vault, so an app can hold several vaults as separate connectors, and signing in
   * goes straight to that vault. A token for another vault is refused here.
   */
  app.post(
    "/v/:vault/mcp",
    (req, res, next) => {
      const vault = String(req.params.vault);
      if (!isVaultName(vault)) {
        res.status(404).json({ error: "not a vault name" });
        return;
      }
      bearerFor(vaultMcpUrl(vault))(req, res, next);
    },
    express.json({ limit: "1mb" }),
    (req, res) => void serveMcp(String(req.params.vault))(req, res),
  );

  /** Where an app learns how to sign in to one vault's address (RFC 9728). */
  app.get("/.well-known/oauth-protected-resource/v/:vault/mcp", (req, res) => {
    const vault = String(req.params.vault);
    if (!isVaultName(vault)) {
      res.status(404).json({ error: "not a vault name" });
      return;
    }
    res.setHeader("access-control-allow-origin", "*");
    res.json({
      resource: vaultMcpUrl(vault).href,
      authorization_servers: [issuerUrl.href],
      resource_name: `Covenant vault ${vault}`,
      resource_documentation: "https://github.com/Len3hq/covenant/blob/main/docs/HOSTED.md",
    });
  });

  const noSessions = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "this server keeps no sessions" }, id: null });
  };
  app.get("/mcp", noSessions);
  app.delete("/mcp", noSessions);
  app.get("/v/:vault/mcp", noSessions);
  app.delete("/v/:vault/mcp", noSessions);

  return app;
}


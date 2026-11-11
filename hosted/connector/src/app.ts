import express, { type Request, type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type Wallet } from "@len3hq/covenant-mcp/server";
import type { ConnectorAuth } from "./auth.js";
import { checkGrant, grantSchema, type ChainView, type Grant, type Terms } from "./grant.js";
import type { KeyHolder } from "./keyholder.js";

export interface AppOptions {
  auth: ConnectorAuth;
  keyHolder: KeyHolder;
  chain: ChainView;
  publicUrl: string;
  /** The dashboards that may hand over a grant: the hosted one, and any local ones for development. */
  dashboardOrigins: string[];
  /** One wallet per vault, so a vault's spends file has one writer. */
  wallet(terms: Terms, grant: Grant, publicKey: string): Wallet;
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
      await checkGrant(grant, options.chain);
      res.json({ redirect: options.auth.completeSignIn(String(body.request), grant) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const bearer = requireBearerAuth({
    verifier: options.auth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  /** Stateless MCP: each request gets a server for the vault its token's grant names. */
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const grant = grantSchema.parse(req.auth?.extra?.grant);
      const terms = await check(grant);
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
  });

  const noSessions = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "this server keeps no sessions" }, id: null });
  };
  app.get("/mcp", noSessions);
  app.delete("/mcp", noSessions);

  return app;
}

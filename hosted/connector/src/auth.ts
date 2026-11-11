import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "node:crypto";
import type { Response } from "express";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { grantSchema, parseTerms, type Grant } from "./grant.js";

/*
 * OAuth for Claude's custom connectors. Signing in means the vault's owner signing a grant with
 * their wallet, on the dashboard. The access token carries that grant, so the connector keeps no
 * accounts: clients and tokens are sealed with the server's secret, and survive a restart.
 */

const PENDING_MS = 10 * 60_000;
const CODE_MS = 5 * 60_000;

/** `base64url(json).base64url(hmac)`, which only this server can make. */
export class Sealer {
  constructor(private readonly secret: Uint8Array) {
    if (secret.length < 32) throw new Error("the connector's secret is at least 32 bytes");
  }

  seal(kind: string, value: unknown): string {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${this.mac(kind, body)}`;
  }

  open<T>(kind: string, sealed: string): T {
    const [body, mac] = sealed.split(".");
    if (!body || !mac || mac !== this.mac(kind, body)) throw new Error(`not a ${kind} this connector made`);
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  }

  private mac(kind: string, body: string): string {
    return Buffer.from(hmac(sha256, this.secret, new TextEncoder().encode(`${kind}.${body}`))).toString("base64url");
  }
}

interface Pending {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  at: number;
}

interface Code {
  clientId: string;
  params: AuthorizationParams;
  grant: Grant;
  at: number;
}

interface SealedToken {
  grant: Grant;
  clientId: string;
  /** Unix seconds: the grant's own expiry. */
  expires: number;
}

export interface ConnectorAuthOptions {
  sealer: Sealer;
  /** Where the owner signs the grant: the dashboard, with `?connect=<request>&connector=<url>`. */
  dashboardUrl: string;
  /** This connector's public URL. */
  publicUrl: string;
}

export class ConnectorAuth implements OAuthServerProvider {
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Code>();

  constructor(private readonly options: ConnectorAuthOptions) {}

  /** Dynamic client registration with nothing stored: the client id is its sealed registration. */
  get clientsStore(): OAuthRegisteredClientsStore {
    const { sealer } = this.options;
    return {
      getClient: async (clientId) => {
        try {
          return { ...sealer.open<Omit<OAuthClientInformationFull, "client_id">>("client", clientId), client_id: clientId };
        } catch {
          return undefined;
        }
      },
      registerClient: async (client) => {
        const registered = { ...client, client_id_issued_at: Math.floor(Date.now() / 1000) };
        return { ...registered, client_id: sealer.seal("client", registered) };
      },
    };
  }

  /** Sends the owner to the dashboard to pick a vault and sign a grant. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    const request = randomBytes(16).toString("hex");
    this.pending.set(request, { client, params, at: Date.now() });
    const target = new URL(this.options.dashboardUrl);
    target.searchParams.set("connect", request);
    target.searchParams.set("connector", this.options.publicUrl);
    res.redirect(target.toString());
  }

  /** The dashboard hands back a grant the owner signed; the answer is where to send their browser. */
  completeSignIn(request: string, grant: Grant): string {
    this.sweep();
    const pending = this.pending.get(request);
    if (!pending) throw new Error("that sign-in expired; start again from Claude");
    this.pending.delete(request);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { clientId: pending.client.client_id, params: pending.params, grant, at: Date.now() });
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state !== undefined) redirect.searchParams.set("state", pending.params.state);
    return redirect.toString();
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.code(client, code).params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<OAuthTokens> {
    const { grant } = this.code(client, code);
    this.codes.delete(code);
    const expires = parseTerms(grant.message).expires;
    const token: SealedToken = { grant, clientId: client.client_id, expires };
    return {
      access_token: this.options.sealer.seal("token", token),
      token_type: "bearer",
      expires_in: Math.max(0, Math.floor(expires - Date.now() / 1000)),
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError("a grant isn't refreshed; sign a new one from Claude");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let sealed: SealedToken;
    try {
      sealed = this.options.sealer.open<SealedToken>("token", token);
    } catch {
      throw new InvalidTokenError("not a token this connector made");
    }
    const grant = grantSchema.parse(sealed.grant);
    if (sealed.expires <= Date.now() / 1000) throw new InvalidTokenError("the grant has expired");
    return { token, clientId: sealed.clientId, scopes: [], expiresAt: sealed.expires, extra: { grant } };
  }

  private code(client: OAuthClientInformationFull, code: string): Code {
    this.sweep();
    const found = this.codes.get(code);
    if (!found || found.clientId !== client.client_id) throw new InvalidGrantError("unknown or used authorization code");
    return found;
  }

  private sweep() {
    const now = Date.now();
    for (const [key, value] of this.pending) if (now - value.at > PENDING_MS) this.pending.delete(key);
    for (const [key, value] of this.codes) if (now - value.at > CODE_MS) this.codes.delete(key);
  }
}

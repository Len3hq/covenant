import { walletConnector } from "./wallet";

/*
 * The hosted connector (docs/HOSTED.md): an agent whose key lives in an OutLayer enclave, for Claude
 * on the web or phone. Nothing here decides anything: the enclave checks every grant again, and the
 * vault checks every payment.
 */

/** Where the connector runs. Unset, the dashboard offers no hosted agents. */
export const CONNECTOR_URL: string | undefined = import.meta.env.VITE_CONNECTOR_URL?.replace(/\/$/, "") || undefined;

export const GRANT_RECIPIENT = "covenant-hosted";
const DAY_S = 86_400;

export interface GrantTerms {
  owner: string;
  vault: string;
  agent: string;
  /** Unix seconds. */
  expires: number;
}

export interface Grant {
  message: string;
  nonce: string;
  public_key: string;
  signature: string;
}

/** The message the owner signs, as hosted/enclave/src/grant.rs reads it. */
export const grantMessage = (terms: GrantTerms) =>
  `covenant-hosted:v1 owner=${terms.owner} vault=${terms.vault} agent=${terms.agent} expires=${terms.expires}`;

export const grantExpiry = (days: number, nowMs = Date.now()) => Math.floor(nowMs / 1000) + days * DAY_S;

/** The access key every hosted agent carries: the enclave's public key. */
export async function hostedPublicKey(connector: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(`${connector}/public-key`);
  const body = (await response.json().catch(() => ({}))) as { public_key?: string; error?: string };
  if (!response.ok || !body.public_key?.startsWith("ed25519:")) {
    throw new Error(`The hosted connector didn't give its key: ${body.error ?? response.status}`);
  }
  return body.public_key;
}

/** Asks the owner's wallet to sign the grant, as a NEP-413 message. */
export async function signGrant(rpcUrl: string, terms: GrantTerms): Promise<Grant> {
  const message = grantMessage(terms);
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const wallet = await (await walletConnector(rpcUrl)).wallet();
  const signed = await wallet.signMessage({ message, recipient: GRANT_RECIPIENT, nonce, signerId: terms.owner });
  if (signed.accountId !== terms.owner) throw new Error(`The wallet signed as ${signed.accountId}, not ${terms.owner}`);
  return {
    message,
    nonce: btoa(String.fromCharCode(...nonce)),
    public_key: signed.publicKey,
    signature: signed.signature,
  };
}

/** Hands the grant to the connector, and answers where to send the browser: back to Claude. */
export async function submitGrant(
  connector: string,
  request: string,
  grant: Grant,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(`${connector}/grant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request, grant }),
  });
  const body = (await response.json().catch(() => ({}))) as { redirect?: string; error?: string };
  if (!response.ok || !body.redirect) throw new Error(body.error ?? `The connector answered ${response.status}`);
  return body.redirect;
}

/** The connector URL Claude takes, for Settings → Connectors → Add custom connector. */
export const connectorMcpUrl = (connector: string) => `${connector}/mcp`;

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { z } from "zod";

/*
 * A vault owner's permission for the connector to drive one hosted agent. The key holder checks it
 * again inside the enclave before it signs anything; the checks here only answer the owner sooner.
 * The format matches hosted/enclave/src/grant.rs.
 */

export const GRANT_RECIPIENT = "covenant-hosted";
const PREFIX = "covenant-hosted:v1";
const NEP413_TAG = 2 ** 31 + 413;

export const grantSchema = z.strictObject({
  message: z.string(),
  nonce: z.string(),
  public_key: z.string().startsWith("ed25519:"),
  signature: z.string(),
});
export type Grant = z.infer<typeof grantSchema>;

export interface Terms {
  owner: string;
  vault: string;
  agent: string;
  /** Unix seconds. */
  expires: number;
}

export const grantMessage = (terms: Terms) =>
  `${PREFIX} owner=${terms.owner} vault=${terms.vault} agent=${terms.agent} expires=${terms.expires}`;

export function parseTerms(message: string): Terms {
  const [prefix, ...parts] = message.split(" ");
  if (prefix !== PREFIX || parts.length !== 4) throw new Error(`a grant reads "${PREFIX} owner=… vault=… agent=… expires=…"`);
  const value = (index: number, name: string) => {
    const part = parts[index] ?? "";
    if (!part.startsWith(`${name}=`) || part.length === name.length + 1) throw new Error(`a grant names ${name}`);
    return part.slice(name.length + 1);
  };
  const expires = Number(value(3, "expires"));
  if (!Number.isSafeInteger(expires)) throw new Error("a grant's expiry is unix seconds");
  return { owner: value(0, "owner"), vault: value(1, "vault"), agent: value(2, "agent"), expires };
}

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
const borshString = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return [...u32(bytes.length), ...bytes];
};

/** The hash a NEAR wallet signs for `signMessage`, per NEP-413, with no callback URL. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  return sha256(Uint8Array.from([...u32(NEP413_TAG), ...borshString(message), ...nonce, ...borshString(recipient), 0]));
}

/** The grant's terms, once its signature verifies under the key it names. */
export function verifyGrant(grant: Grant): Terms {
  const terms = parseTerms(grant.message);
  const nonce = Buffer.from(grant.nonce, "base64");
  const signature = Buffer.from(grant.signature, "base64");
  const key = base58.decode(grant.public_key.slice("ed25519:".length));
  if (signature.length !== 64 || key.length !== 32) throw new Error("a grant carries a 64-byte signature and a 32-byte key");
  if (!ed25519.verify(signature, nep413Hash(grant.message, nonce, GRANT_RECIPIENT), key)) {
    throw new Error("the grant's signature doesn't verify");
  }
  return terms;
}

export interface ChainView {
  isFullAccess(account: string, publicKey: string): Promise<boolean>;
  roles(vault: string): Promise<{ owner: string; agent: string }>;
}

/** Everything the key holder checks, so a bad grant is refused when it's given, not on the first payment. */
export async function checkGrant(grant: Grant, chain: ChainView, nowSeconds = Date.now() / 1000): Promise<Terms> {
  const terms = verifyGrant(grant);
  if (terms.expires <= nowSeconds) throw new Error("the grant has expired");
  if (!(await chain.isFullAccess(terms.owner, grant.public_key))) {
    throw new Error(`the grant's key isn't a full-access key of ${terms.owner}`);
  }
  const roles = await chain.roles(terms.vault);
  if (roles.owner !== terms.owner || roles.agent !== terms.agent) {
    throw new Error(`${terms.vault} doesn't name ${terms.owner} as owner and ${terms.agent} as agent`);
  }
  return terms;
}

/** NEAR testnet, read over JSON-RPC. */
export function rpcChainView(rpcUrl: string, fetcher: typeof fetch = fetch): ChainView {
  const query = async (params: object) => {
    const response = await fetcher(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "covenant", method: "query", params: { finality: "final", ...params } }),
    });
    return (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  };
  return {
    async isFullAccess(account, publicKey) {
      const { result } = await query({ request_type: "view_access_key", account_id: account, public_key: publicKey });
      return result?.permission === "FullAccess";
    },
    async roles(vault) {
      const { result, error } = await query({
        request_type: "call_function",
        account_id: vault,
        method_name: "get_roles",
        args_base64: "",
      });
      if (!Array.isArray(result?.result)) throw new Error(`${vault} isn't a Covenant vault: ${JSON.stringify(error)}`);
      return JSON.parse(Buffer.from(result.result as number[]).toString()) as { owner: string; agent: string };
    },
  };
}

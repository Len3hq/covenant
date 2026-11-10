import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import type { Transaction } from "./wallet";

/*
 * The agent's own NEAR account, made from the owner's wallet so nobody needs a terminal. It's a
 * subaccount of the owner's, funded for gas, with one key that can only ask this vault for
 * payments. No full-access key is added, so not even the owner can do more with it; to retire it,
 * the owner points the vault at a new agent with `set_agent`.
 */

/** 0.5 NEAR: the account's storage and the gas the agent burns. It can't be withdrawn later. */
export const AGENT_FUNDING_YOCTO = "500000000000000000000000";
/** At most 1 NEAR of gas for the key, as `make agent-key` gives it. */
export const AGENT_ALLOWANCE_YOCTO = "1000000000000000000000000";
export const AGENT_METHODS = ["propose_spend", "execute"];
const ACCOUNT_LIMIT = 64;

export interface AgentKey {
  /** `ed25519:<base58>` */
  publicKey: string;
  /** `ed25519:<base58 of seed and public key>`, the form near-api-js and `.env` use. */
  secretKey: string;
}

/** A new key, made in the browser. The secret is never stored or sent anywhere by this page. */
export function newAgentKey(seed: Uint8Array = ed25519.utils.randomSecretKey()): AgentKey {
  const publicKey = ed25519.getPublicKey(seed);
  const both = new Uint8Array(64);
  both.set(seed);
  both.set(publicKey, 32);
  return { publicKey: `ed25519:${base58.encode(publicKey)}`, secretKey: `ed25519:${base58.encode(both)}` };
}

/** `name.owner`, the only kind of account the owner's wallet can create. */
export function agentAccountId(name: string, owner: string): string {
  const label = name.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(label)) {
    throw new Error("The agent's name can use lowercase letters, digits, - and _, with no dots");
  }
  if (/^[0-9a-f]{64}$/.test(owner) || /^0x[0-9a-f]{40}$/.test(owner)) {
    throw new Error("Your wallet's account has no name, so it can't create one under it. Use an agent account you already have.");
  }
  const agent = `${label}.${owner}`;
  if (agent.length > ACCOUNT_LIMIT) throw new Error(`${agent} is longer than NEAR's 64-character limit`);
  return agent;
}

const agentKeyAction = (vault: string, publicKey: string) => ({
  type: "AddKey" as const,
  params: {
    publicKey,
    accessKey: {
      permission: { receiverId: vault, allowance: AGENT_ALLOWANCE_YOCTO, methodNames: AGENT_METHODS },
    },
  },
});

/**
 * Creates the agent's account, funds it and adds its key, in one transaction from the owner. The
 * key names the vault before it exists, which NEAR allows.
 */
export function createAgentTransaction(agent: string, vault: string, publicKey: string): Transaction {
  return {
    receiverId: agent,
    actions: [
      { type: "CreateAccount" },
      { type: "Transfer", params: { deposit: AGENT_FUNDING_YOCTO } },
      agentKeyAction(vault, publicKey),
    ],
  };
}

/** Adds a vault-only key to an agent account the connected wallet already controls. */
export function addAgentKeyTransaction(agent: string, vault: string, publicKey: string): Transaction {
  return { receiverId: agent, actions: [agentKeyAction(vault, publicKey)] };
}

/** Removes one key from the agent account, signed by the agent account's own wallet. */
export function removeAgentKeyTransaction(agent: string, publicKey: string): Transaction {
  return { receiverId: agent, actions: [{ type: "DeleteKey", params: { publicKey } }] };
}

export async function accountExists(rpcUrl: string, accountId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const response = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "exists",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { cause?: { name?: string } } };
  if (body.result) return true;
  if (body.error?.cause?.name === "UNKNOWN_ACCOUNT") return false;
  throw new Error(`Couldn't check whether ${accountId} exists`);
}

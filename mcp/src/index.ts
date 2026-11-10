#!/usr/bin/env node
// Runs the Covenant MCP server over stdio. Logs go to stderr, because stdout carries the protocol.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Covenant } from "@covenant/sdk";
import { createServer } from "./server.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. See the Covenant docs for the MCP setup.`);
    process.exit(1);
  }
  return value;
}

const wallet = Covenant.connect({
  vault: requireEnv("VAULT_ACCOUNT_ID"),
  agentAccount: requireEnv("AGENT_ACCOUNT_ID"),
  agentKey: requireEnv("AGENT_PRIVATE_KEY"),
  ...(process.env.NEAR_RPC_URL ? { nearRpcUrl: process.env.NEAR_RPC_URL } : {}),
  ...(process.env.SOL_RPC_URL ? { solRpcUrl: process.env.SOL_RPC_URL } : {}),
  // Comma-separated durable nonce accounts from `make sol-nonce`. Solana payments need at least one.
  solNonceAccounts: (process.env.SOL_NONCE_ACCOUNTS ?? "")
    .split(",")
    .map((account) => account.trim())
    .filter(Boolean),
  spendsFile: process.env.SPENDS_FILE || "covenant-spends.json",
});

await createServer(wallet).connect(new StdioServerTransport());

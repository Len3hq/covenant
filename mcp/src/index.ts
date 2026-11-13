#!/usr/bin/env node
// Runs the Covenant MCP server over stdio. Logs go to stderr, because stdout carries the protocol.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Covenant, startAutoExecute } from "@len3hq/covenant-sdk";
import { createRequire } from "node:module";
import { createServer } from "./server.js";
import { runSolNonce } from "./solNonce.js";
import { spendsFile } from "./spends.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `covenant-mcp ${version}: an MCP server that pays from a Covenant vault, which decides every payment.

Settings, as environment variables:
  VAULT_ACCOUNT_ID    the vault, such as acme.vaults-v3.len3hq.testnet
  AGENT_ACCOUNT_ID    the agent's NEAR account
  AGENT_PRIVATE_KEY   the agent's key, which can only ask the vault for payments
  SPENDS_FILE         optional; where payments are recorded so none is paid twice
                      (default ~/.covenant/<vault>-spends.json)
  NEAR_RPC_URL, SOL_RPC_URL, SOL_NONCE_ACCOUNTS   optional
  AUTO_EXECUTE        optional; "off" stops it sending held payments by itself once their
                      wait ends. On by default, while the server runs.

For Solana payments, create a durable nonce account the vault controls, once, then add the
SOL_NONCE_ACCOUNTS it prints to the same settings:
  VAULT_ACCOUNT_ID=<vault> npx -y @len3hq/covenant-mcp@latest sol-nonce

Claude Desktop, Cursor and other MCP apps: "command": "npx", "args": ["-y", "@len3hq/covenant-mcp"].
Docs: https://covenant.len3.xyz/?docs#mcp`;

const flag = process.argv[2];
if (flag === "--version" || flag === "-v") {
  console.log(version);
  process.exit(0);
}
if (flag === "--help" || flag === "-h") {
  console.log(HELP);
  process.exit(0);
}
if (flag === "sol-nonce") {
  process.exit(await runSolNonce({ env: process.env }));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set.\n\n${HELP}`);
    process.exit(1);
  }
  return value;
}

const vault = requireEnv("VAULT_ACCOUNT_ID");
// Every chain the SDK talks to is a testnet, so a mainnet vault would be paid against the wrong ones.
if (!vault.endsWith(".testnet")) {
  console.error(`${vault} isn't a testnet account. This release pays on testnets only.`);
  process.exit(1);
}

const wallet = Covenant.connect({
  vault,
  agentAccount: requireEnv("AGENT_ACCOUNT_ID"),
  agentKey: requireEnv("AGENT_PRIVATE_KEY"),
  ...(process.env.NEAR_RPC_URL ? { nearRpcUrl: process.env.NEAR_RPC_URL } : {}),
  ...(process.env.SOL_RPC_URL ? { solRpcUrl: process.env.SOL_RPC_URL } : {}),
  // Comma-separated durable nonce accounts from `covenant-mcp sol-nonce`. Solana payments need at least one.
  solNonceAccounts: (process.env.SOL_NONCE_ACCOUNTS ?? "")
    .split(",")
    .map((account) => account.trim())
    .filter(Boolean),
  spendsFile: spendsFile(vault, process.env.SPENDS_FILE),
});

await createServer(wallet, { vault }).connect(new StdioServerTransport());

// A held payment goes through unless vetoed: once its wait ends, send it, for as long as the app
// keeps this server running. The vault checks it against its rules again first.
if (process.env.AUTO_EXECUTE !== "off") {
  startAutoExecute(wallet, {
    onResult: (result) => console.error(JSON.stringify({ step: "auto_execute", ...result }, (_, v: unknown) => (typeof v === "bigint" ? `${v}` : v))),
  });
}

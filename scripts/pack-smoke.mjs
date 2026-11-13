// Packs the SDK and MCP server as npm would publish them, installs both tarballs into an empty
// folder, and checks the installed `covenant-mcp`: --version, then an MCP handshake that lists the
// tools. Usage: `node scripts/pack-smoke.mjs`. Needs network access to install dependencies.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const out = mkdtempSync(join(tmpdir(), "covenant-pack-"));
for (const pkg of ["sdk", "mcp"]) run("pnpm", ["pack", "--pack-destination", out], pkg);
const tarballs = readdirSync(out).filter((name) => name.endsWith(".tgz")).map((name) => join(out, name));
console.log(`packed ${tarballs.map((t) => t.split("/").pop()).join(", ")}`);

const app = mkdtempSync(join(tmpdir(), "covenant-app-"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs], app);
const bin = join(app, "node_modules", ".bin", "covenant-mcp");

const version = run(bin, ["--version"], app).trim();
console.log(`covenant-mcp --version: ${version}`);

// Any well-formed key will do: listing tools never signs or reads the chain.
const key = run("node", ["-e", "import('near-api-js').then(({KeyPair}) => console.log(KeyPair.fromRandom('ed25519').toString()))"], app).trim();
const server = spawn(bin, [], {
  cwd: app,
  env: { ...process.env, VAULT_ACCOUNT_ID: "smoke.vaults.len3hq.testnet", AGENT_ACCOUNT_ID: "smoke-agent.testnet", AGENT_PRIVATE_KEY: key, HOME: app },
  stdio: ["pipe", "pipe", "inherit"],
});
const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const tools = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no tools/list answer in 20 s")), 20_000);
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (const line of buffer.split("\n").slice(0, -1)) {
      const message = JSON.parse(line);
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      }
      if (message.id === 2) {
        clearTimeout(timer);
        resolve(message.result.tools.map((tool) => tool.name).sort());
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  });
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-smoke", version: "0" } },
  });
});
server.kill();
const expected = ["execute_queued", "fetch", "get_addresses", "get_balances", "get_payment_status", "list_destinations", "list_payees", "list_queue", "pay", "quote_payment", "search"];
if (JSON.stringify(tools) !== JSON.stringify(expected)) throw new Error(`unexpected tools: ${tools.join(", ")}`);
console.log(`the installed server lists ${tools.length} tools: ${tools.join(", ")}`);

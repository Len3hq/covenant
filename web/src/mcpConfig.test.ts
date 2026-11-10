import { describe, expect, it } from "vitest";
import { claudeCodeCommand, desktopConfig, envLines, installSteps } from "./mcpConfig";

const values = { vault: "acme.vaults.testnet", agent: "agent.alice.testnet", key: "ed25519:SECRET" };

describe("MCP settings", () => {
  it("start the server with npx once it's published", () => {
    const config = JSON.parse(desktopConfig(values, true)) as {
      mcpServers: { covenant: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(config.mcpServers.covenant.command).toBe("npx");
    expect(config.mcpServers.covenant.args).toEqual(["-y", "@len3hq/covenant-mcp"]);
    expect(config.mcpServers.covenant.env).toEqual({
      VAULT_ACCOUNT_ID: "acme.vaults.testnet",
      AGENT_ACCOUNT_ID: "agent.alice.testnet",
      AGENT_PRIVATE_KEY: "ed25519:SECRET",
    });
    expect(claudeCodeCommand(values, true)).toContain("-- npx -y @len3hq/covenant-mcp");
    expect(installSteps(true)).toBe("npm install @len3hq/covenant-sdk");
  });

  it("start a local build before then", () => {
    expect(desktopConfig(values, false)).toContain("/path/to/covenant/mcp/dist/index.js");
    expect(claudeCodeCommand(values, false)).toContain("-- node /path/to/covenant/mcp/dist/index.js");
    expect(installSteps(false)).toContain("git clone");
  });

  it("write .env lines", () => {
    expect(envLines(values)).toBe(
      "VAULT_ACCOUNT_ID=acme.vaults.testnet\nAGENT_ACCOUNT_ID=agent.alice.testnet\nAGENT_PRIVATE_KEY=ed25519:SECRET",
    );
  });
});

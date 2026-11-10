/*
 * The settings that connect an MCP app to a vault. Once the server is on npm, apps start it with
 * npx; before that, from a clone of the repo. `VITE_MCP_PUBLISHED=true` at build time switches the
 * page to npx, after the first `npm publish`.
 */

export const MCP_PACKAGE = "@len3hq/covenant-mcp";
export const SDK_PACKAGE = "@len3hq/covenant-sdk";
export const MCP_PUBLISHED: boolean = import.meta.env.VITE_MCP_PUBLISHED === "true";

export interface McpValues {
  vault: string;
  agent: string;
  key: string;
}

/** How the app starts the server: npx once published, otherwise node on a local build. */
function launcher(published: boolean): { command: string; args: string[] } {
  return published
    ? { command: "npx", args: ["-y", MCP_PACKAGE] }
    : { command: "node", args: ["/path/to/covenant/mcp/dist/index.js"] };
}

/** For Claude Desktop's `claude_desktop_config.json` and Cursor's `~/.cursor/mcp.json`. */
export function desktopConfig(values: McpValues, published = MCP_PUBLISHED): string {
  const { command, args } = launcher(published);
  return JSON.stringify(
    {
      mcpServers: {
        covenant: {
          command,
          args,
          env: { VAULT_ACCOUNT_ID: values.vault, AGENT_ACCOUNT_ID: values.agent, AGENT_PRIVATE_KEY: values.key },
        },
      },
    },
    null,
    2,
  );
}

export function claudeCodeCommand(values: McpValues, published = MCP_PUBLISHED): string {
  const { command, args } = launcher(published);
  return [
    "claude mcp add covenant \\",
    `  -e VAULT_ACCOUNT_ID=${values.vault} \\`,
    `  -e AGENT_ACCOUNT_ID=${values.agent} \\`,
    `  -e AGENT_PRIVATE_KEY=${values.key} \\`,
    `  -- ${[command, ...args].join(" ")}`,
  ].join("\n");
}

export function envLines(values: McpValues): string {
  return `VAULT_ACCOUNT_ID=${values.vault}\nAGENT_ACCOUNT_ID=${values.agent}\nAGENT_PRIVATE_KEY=${values.key}`;
}

/** How to get the SDK: from npm once published, otherwise built from the repo. */
export function installSteps(published = MCP_PUBLISHED): string {
  return published
    ? `npm install ${SDK_PACKAGE}`
    : `git clone https://github.com/Len3hq/covenant && cd covenant
pnpm install
pnpm --filter "${MCP_PACKAGE}..." build   # builds the SDK and the MCP server`;
}

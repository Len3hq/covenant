import { useState } from "react";
import { claudeCodeCommand, desktopConfig, envLines, MCP_PUBLISHED, SDK_PACKAGE, type McpValues } from "./mcpConfig";

/*
 * The settings that connect an agent to its vault, with the vault, agent and key filled in. It is
 * shown once, right after a key is made: nothing on the page keeps the key, so closing it loses it.
 */

type Tab = "desktop" | "code" | "cursor" | "env";

const TABS: { id: Tab; label: string }[] = [
  { id: "desktop", label: "Claude Desktop" },
  { id: "code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "env", label: "Your own code" },
];

export function sdkExample(values: McpValues): string {
  return `import { Covenant } from "${SDK_PACKAGE}";

const wallet = Covenant.connect({
  vault: process.env.VAULT_ACCOUNT_ID!,
  agentAccount: process.env.AGENT_ACCOUNT_ID!,
  agentKey: process.env.AGENT_PRIVATE_KEY!,
});
// For example: await wallet.pay({ asset: "BTC", to: "<payee>", amount: 20_000n, reference: "INV-1" });
// ${values.vault}`;
}

/** What each tab shows, and where it goes. */
export function snippetFor(tab: Tab, values: McpValues): { where: string; text: string } {
  switch (tab) {
    case "desktop":
      return {
        where:
          "Paste into claude_desktop_config.json (macOS: ~/Library/Application Support/Claude/, Windows: %APPDATA%\\Claude\\), then restart Claude Desktop.",
        text: desktopConfig(values),
      };
    case "code":
      return { where: "Run in a terminal.", text: claudeCodeCommand(values) };
    case "cursor":
      return { where: "Paste into ~/.cursor/mcp.json, then restart Cursor.", text: desktopConfig(values) };
    case "env":
      return { where: "Save as .env next to your agent's code.", text: `${envLines(values)}\n\n${sdkExample(values)}` };
  }
}

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = ".env";
  link.click();
  URL.revokeObjectURL(url);
}

export function ConnectAgent({ values, intro }: { values: McpValues; intro?: string }) {
  const [tab, setTab] = useState<Tab>("desktop");
  const [copied, setCopied] = useState(false);
  const { where, text } = snippetFor(tab, values);
  return (
    <div className="agent-secret connect-agent">
      <p>
        <strong>Save your agent's key now.</strong> It's shown only this once, and this page keeps no copy.{" "}
        {intro ?? `It can only ask ${values.vault} for payments, within the rules you set.`}
      </p>
      <div className="tabs" role="tablist">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "tab tab-on" : "tab"}
            onClick={() => {
              setTab(id);
              setCopied(false);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">{where}</p>
      <pre className="mono">{text}</pre>
      <div className="faucet-buttons">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="ghost" onClick={() => download(envLines(values))}>
          Download .env
        </button>
      </div>
      {!MCP_PUBLISHED && tab !== "env" && (
        <p className="muted small">
          Until the server is on npm, build it first: clone the repo, run <code>pnpm install</code> and{" "}
          <code>pnpm --filter "@len3hq/covenant-mcp..." build</code>, and replace /path/to/covenant with your clone.
        </p>
      )}
      <p className="muted small">
        The key sits in that file as plain text. That's acceptable only because it can do nothing but ask this vault,
        which applies your rules; don't use it anywhere else. To test it, ask your assistant "what are my vault's
        addresses?"
      </p>
    </div>
  );
}

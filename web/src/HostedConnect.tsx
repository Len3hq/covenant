import { useState } from "react";
import { connectorMcpUrl } from "./hosted";

/*
 * How to add the hosted connector to an AI app. Any app that adds a remote MCP server by URL, with
 * OAuth sign-in, can use it; each one then sends the owner to this dashboard to sign a grant.
 */

export type HostedTab = "claude" | "chatgpt" | "claude-code" | "cursor" | "vscode" | "other";

export const HOSTED_TABS: { id: HostedTab; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "other", label: "Other apps" },
];

/** Where the connector goes in each app, and what to paste. */
export function hostedSnippetFor(tab: HostedTab, url: string): { steps: string; text: string } {
  switch (tab) {
    case "claude":
      return {
        steps:
          "On claude.ai or Claude Desktop: Settings → Connectors → Add custom connector. Name it Covenant, paste the URL, and press Connect. It then works on Claude's phone apps too.",
        text: url,
      };
    case "chatgpt":
      return {
        steps:
          "In ChatGPT's settings, turn on developer mode for connectors, then create a connector with this URL and OAuth sign-in. The menu names change between versions.",
        text: url,
      };
    case "claude-code":
      return {
        steps: "Run this in a terminal, then start claude, run /mcp, pick covenant and choose Authenticate.",
        text: `claude mcp add --transport http covenant ${url}`,
      };
    case "cursor":
      return {
        steps: "Add this to ~/.cursor/mcp.json, then open Cursor's MCP settings and press Login next to covenant.",
        text: JSON.stringify({ mcpServers: { covenant: { url } } }, null, 2),
      };
    case "vscode":
      return {
        steps: "Add this to .vscode/mcp.json in your project, then start the server from that file and sign in when asked.",
        text: JSON.stringify({ servers: { covenant: { type: "http", url } } }, null, 2),
      };
    case "other":
      return {
        steps:
          "Any app or agent framework that adds a remote MCP server by URL, with OAuth sign-in, can use it: Streamable HTTP transport, and the app registers itself. Apps that only take a fixed API key can't.",
        text: url,
      };
  }
}

/** A button that copies `text`, and says so. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost copy-button"
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "✓ Copied" : `⧉ ${label}`}
    </button>
  );
}

/** The connector URL with a copy button, and a tab per AI app. */
export function HostedConnect({ connector }: { connector: string }) {
  const url = connectorMcpUrl(connector);
  const [tab, setTab] = useState<HostedTab>("claude");
  const { steps, text } = hostedSnippetFor(tab, url);
  return (
    <div className="connect-agent">
      <div className="copy-row">
        <pre className="mono">{url}</pre>
        <CopyButton text={url} label="Copy URL" />
      </div>
      <div className="tabs" role="tablist">
        {HOSTED_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "tab tab-on" : "tab"}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">{steps}</p>
      {text !== url && (
        <div className="copy-row">
          <pre className="mono">{text}</pre>
          <CopyButton text={text} />
        </div>
      )}
      <p className="muted small">
        Each app then sends you to this dashboard to pick the vault and sign a grant with your wallet. The grant lets the
        enclave ask that vault for payments until it expires; the vault still applies all your rules.
      </p>
    </div>
  );
}

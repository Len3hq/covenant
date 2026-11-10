import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectAgent, snippetFor } from "./ConnectAgent";

const values = { vault: "acme.vaults.testnet", agent: "agent.alice.testnet", key: "ed25519:SECRET" };

describe("ConnectAgent", () => {
  it("fills the vault, agent and key into every tab", () => {
    for (const tab of ["desktop", "code", "cursor", "env"] as const) {
      const { text, where } = snippetFor(tab, values);
      for (const value of Object.values(values)) expect(text).toContain(value);
      expect(where.length).toBeGreaterThan(0);
    }
    expect(snippetFor("desktop", values).where).toContain("claude_desktop_config.json");
    expect(snippetFor("cursor", values).where).toContain("~/.cursor/mcp.json");
    expect(snippetFor("code", values).text).toContain("claude mcp add covenant");
    expect(snippetFor("env", values).text).toContain("@len3hq/covenant-sdk");
  });

  it("opens on Claude Desktop, with copy, download and the plain-text warning", () => {
    const html = renderToString(<ConnectAgent values={values} />).replaceAll("<!-- -->", "");
    expect(html).toContain("Save your agent&#x27;s key now");
    expect(html).toContain("&quot;AGENT_PRIVATE_KEY&quot;: &quot;ed25519:SECRET&quot;");
    expect(html).toContain("Copy</button>");
    expect(html).toContain("Download .env</button>");
    expect(html).toContain("plain text");
  });
});

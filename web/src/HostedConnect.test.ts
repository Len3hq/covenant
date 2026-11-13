import { describe, expect, it } from "vitest";
import { HOSTED_TABS, hostedSnippetFor, serverNameFor } from "./HostedConnect";

const url = "https://connector.example/v/acme.vaults-v3.len3hq.testnet/mcp";

describe("hostedSnippetFor", () => {
  it("gives every app the connector URL", () => {
    for (const { id } of HOSTED_TABS) expect(hostedSnippetFor(id, url).text).toContain(url);
  });

  it("writes each app's own config, under the vault's own name", () => {
    expect(hostedSnippetFor("claude-code", url).text).toBe(`claude mcp add --transport http covenant-acme ${url}`);
    expect(JSON.parse(hostedSnippetFor("cursor", url).text)).toEqual({ mcpServers: { "covenant-acme": { url } } });
    expect(JSON.parse(hostedSnippetFor("vscode", url).text)).toEqual({ servers: { "covenant-acme": { type: "http", url } } });
    expect(hostedSnippetFor("claude", url).steps).toContain("Name it covenant-acme");
  });

  it("names two vaults apart, so adding the second doesn't replace the first", () => {
    const other = "https://connector.example/v/frank-hosted.vaults-v3.len3hq.testnet/mcp";
    expect(serverNameFor(other)).toBe("covenant-frank-hosted");
    expect(serverNameFor(other)).not.toBe(serverNameFor(url));
  });

  it("keeps the docs' placeholder a placeholder", () => {
    expect(serverNameFor("https://connector.example/v/<vault>/mcp")).toBe("covenant-<vault>");
    expect(serverNameFor("https://connector.example/mcp")).toBe("covenant");
  });
});

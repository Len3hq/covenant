import { describe, expect, it } from "vitest";
import { HOSTED_TABS, hostedSnippetFor } from "./HostedConnect";

const url = "https://connector.example/mcp";

describe("hostedSnippetFor", () => {
  it("gives every app the connector URL", () => {
    for (const { id } of HOSTED_TABS) expect(hostedSnippetFor(id, url).text).toContain(url);
  });

  it("writes each app's own config", () => {
    expect(hostedSnippetFor("claude-code", url).text).toBe(`claude mcp add --transport http covenant ${url}`);
    expect(JSON.parse(hostedSnippetFor("cursor", url).text)).toEqual({ mcpServers: { covenant: { url } } });
    expect(JSON.parse(hostedSnippetFor("vscode", url).text)).toEqual({ servers: { covenant: { type: "http", url } } });
  });
});

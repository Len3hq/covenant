import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Docs } from "./Docs";
import { REFUSALS } from "./vault";

describe("Docs", () => {
  const html = renderToString(<Docs />);

  it("covers setup, the SDK and the MCP server", () => {
    for (const text of ["Quick start", "@len3hq/covenant-sdk", "claude mcp add covenant", "make agent-key ENV_FILE="]) {
      expect(html).toContain(text);
    }
  });

  it("walks through creating, managing, hosted agents and every AI app", () => {
    for (const text of ["Sign 2 of 2", "Change the rules", "Sign and connect", "claude mcp add --transport http", "ChatGPT", ".vscode/mcp.json", "Troubleshooting"]) {
      expect(html).toContain(text);
    }
  });

  it("lists every refusal the dashboard can explain, by its CovenantError name", () => {
    for (const name of Object.keys(REFUSALS)) expect(html).toContain(`<code>${name}</code>`);
  });
});

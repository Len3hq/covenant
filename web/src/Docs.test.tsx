import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Docs } from "./Docs";
import { REFUSALS } from "./vault";

describe("Docs", () => {
  const html = renderToString(<Docs />);

  it("covers setup, the SDK and the MCP server", () => {
    for (const text of ["Quick start", "@len3hq/covenant-sdk", "claude mcp add covenant", "make agent-key"]) {
      expect(html).toContain(text);
    }
  });

  it("lists every refusal the dashboard can explain, by its CovenantError name", () => {
    for (const name of Object.keys(REFUSALS)) expect(html).toContain(`<code>${name}</code>`);
  });
});

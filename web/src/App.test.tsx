import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders every panel", () => {
    const html = renderToString(<App />);
    for (const title of ["Balances", "Policy", "Queue", "Activity log"]) {
      expect(html).toContain(title);
    }
  });
});

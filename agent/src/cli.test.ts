import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("reads the scenario and replay flag", () => {
    expect(parseArgs(["pay", "--replay"])).toEqual({ scenario: "pay", replay: true });
  });

  it("defaults to a live run", () => {
    expect(parseArgs(["queue"]).replay).toBe(false);
  });

  it("refuses an unknown scenario", () => {
    expect(() => parseArgs(["drain"])).toThrow();
  });
});

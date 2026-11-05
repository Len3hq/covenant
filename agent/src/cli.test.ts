import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("reads the scenario and replay flag", () => {
    expect(parseArgs(["pay", "--replay"])).toEqual({ scenario: "pay", replay: true });
  });

  it("defaults to a live run", () => {
    expect(parseArgs(["queue"]).replay).toBe(false);
  });

  it("reads a run to resume, wherever the flag sits", () => {
    expect(parseArgs(["--run", "abc", "pay"])).toEqual({ scenario: "pay", replay: false, run: "abc" });
    expect(parseArgs(["pay", "--run", "abc"]).run).toBe("abc");
  });

  it("refuses an unknown scenario", () => {
    expect(() => parseArgs(["drain"])).toThrow();
  });
});

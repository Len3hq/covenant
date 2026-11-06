import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("defaults to replaying in the sandbox, which needs no keys", () => {
    expect(parseArgs(["pay"])).toEqual({ scenario: "pay", live: false, llm: false, record: false });
  });

  it("reads the live, model and record flags", () => {
    expect(parseArgs(["attack", "--live", "--llm", "--record"])).toMatchObject({
      live: true,
      llm: true,
      record: true,
    });
  });

  it("runs every scenario with all", () => {
    expect(parseArgs(["all"]).scenario).toBe("all");
  });

  it("reads a run to resume, wherever the flag sits", () => {
    expect(parseArgs(["--run", "abc", "pay"]).run).toBe("abc");
    expect(parseArgs(["pay", "--run", "abc"]).run).toBe("abc");
  });

  it("refuses to record a replay, which has nothing to record", () => {
    expect(() => parseArgs(["pay", "--record"])).toThrow("--record needs --llm");
  });

  it("refuses an unknown scenario", () => {
    expect(() => parseArgs(["drain"])).toThrow();
  });
});

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spendsFile } from "./spends.js";

describe("spendsFile", () => {
  it("defaults to a private folder in the home folder, one file per vault", () => {
    const home = mkdtempSync(join(tmpdir(), "covenant-home-"));
    const file = spendsFile("acme.vaults.len3hq.testnet", undefined, home);
    expect(file).toBe(join(home, ".covenant", "acme.vaults.len3hq.testnet-spends.json"));
    expect(statSync(join(home, ".covenant")).mode & 0o777).toBe(0o700);
  });

  it("uses SPENDS_FILE when it is set", () => {
    expect(spendsFile("acme.testnet", "/tmp/mine.json", "/nowhere")).toBe("/tmp/mine.json");
  });
});

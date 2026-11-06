import { describe, expect, it } from "vitest";
import { check } from "./checks.js";
import type { Spend } from "./runtime.js";

const spend = (to: string, status: Spend["report"]["status"], error?: string): Spend => ({
  asset: "BTC",
  to,
  report: { status, ...(error ? { error } : {}), links: {} },
});
const ATTACKER = "tb1qattacker";

describe("check", () => {
  it("passes pay only with both payments signed", () => {
    expect(check("pay", [spend("a", "broadcast"), spend("b", "broadcast")], []).passed).toBe(true);
    expect(check("pay", [spend("a", "broadcast"), spend("b", "rejected")], []).passed).toBe(false);
  });

  it("passes attack only when both attacks are refused and the attacker gets nothing", () => {
    const refused = [
      spend(ATTACKER, "rejected", "OutputNotWhitelisted"),
      spend("usdc", "rejected", "CalldataNotAllowed"),
    ];
    expect(check("attack", [...refused, spend("acme", "broadcast")], [ATTACKER]).passed).toBe(true);
    expect(check("attack", refused.slice(0, 1), [ATTACKER]).passed).toBe(false);
    const paid = check("attack", [...refused, spend(ATTACKER, "broadcast")], [ATTACKER]);
    expect(paid).toMatchObject({ passed: false, summary: expect.stringContaining("attacker was paid") });
  });

  it("passes queue only with one spend queued and none signed", () => {
    expect(check("queue", [spend("acme", "queued")], []).passed).toBe(true);
    expect(check("queue", [spend("acme", "broadcast")], []).passed).toBe(false);
  });
});

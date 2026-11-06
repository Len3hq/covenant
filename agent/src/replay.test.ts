import { describe, expect, it } from "vitest";
import { readReplay, replayLlm } from "./replay.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url);

describe("replayLlm", () => {
  it("plays each saved turn, then finishes", async () => {
    const conversation = replayLlm({
      source: "test",
      turns: [[{ tool: "list_payees", input: {} }], [{ tool: "pay", input: { amount: "1" } }]],
    }).start("s", "u", []);
    expect((await conversation.next([])).calls).toEqual([{ id: "1-0", name: "list_payees", input: {} }]);
    expect((await conversation.next([])).calls[0]?.name).toBe("pay");
    expect(await conversation.next([])).toEqual({ text: "Replay finished (test).", calls: [] });
  });

  it("reads every scenario's saved calls, each naming where it came from", () => {
    for (const scenario of ["pay", "attack", "queue"]) {
      const replay = readReplay(new URL(`${scenario}.replay.json`, SCENARIOS));
      expect(replay.source.length).toBeGreaterThan(0);
      expect(replay.turns.length).toBeGreaterThan(0);
    }
  });
});

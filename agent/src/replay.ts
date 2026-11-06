import { readFileSync } from "node:fs";
import { z } from "zod";
import type { LlmClient } from "./llm/index.js";

const replaySchema = z.object({
  /** Where the calls came from: a recorded model run, or written to show what a hijacked agent does. */
  source: z.string(),
  turns: z.array(z.array(z.object({ tool: z.string(), input: z.unknown() }))),
});

export type Replay = z.infer<typeof replaySchema>;

export const readReplay = (url: URL): Replay => replaySchema.parse(JSON.parse(readFileSync(url, "utf8")));

/** Plays saved tool calls through the normal agent loop, so a demo needs no model or key. */
export function replayLlm(replay: Replay): LlmClient {
  return {
    start: () => {
      let turn = 0;
      return {
        next: async () => {
          const calls = replay.turns[turn] ?? [];
          turn += 1;
          if (calls.length === 0) return { text: `Replay finished (${replay.source}).`, calls: [] };
          return {
            text: "",
            calls: calls.map(({ tool, input }, index) => ({ id: `${turn}-${index}`, name: tool, input })),
          };
        },
      };
    },
  };
}

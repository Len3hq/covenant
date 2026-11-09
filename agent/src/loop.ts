import type { LlmClient, ToolResult } from "./llm/index.js";
import type { Log } from "@covenant/sdk";
import type { Tool } from "./tools.js";

const MAX_TURNS = 12;

const stringify = (value: unknown) =>
  JSON.stringify(value, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item));

/**
 * Runs the model until it stops calling tools. Calls run in order, because EVM nonces depend on it.
 * A failed tool tells the model what went wrong, so it can report or adapt.
 */
export async function runAgent(args: {
  llm: LlmClient;
  system: string;
  user: string;
  tools: Tool[];
  log: Log;
  /** Sees each turn's calls, so a live run can be saved as a replay. */
  onTurn?: (calls: { tool: string; input: unknown }[]) => void;
}): Promise<string> {
  const { llm, system, user, tools, log, onTurn } = args;
  const conversation = llm.start(system, user, tools.map((tool) => tool.spec));
  let results: ToolResult[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const { text, calls } = await conversation.next(results);
    if (calls.length === 0) return text;
    onTurn?.(calls.map(({ name, input }) => ({ tool: name, input })));
    results = [];
    for (const { id, name, input } of calls) {
      log("tool_call", { tool: name, input });
      const tool = tools.find((candidate) => candidate.spec.name === name);
      try {
        if (!tool) throw new Error(`no tool named ${name}`);
        const content = stringify(await tool.run(input));
        log("tool_result", { tool: name, result: content });
        results.push({ id, content, isError: false });
      } catch (error) {
        log("tool_error", { tool: name, error: String(error) });
        results.push({ id, content: String(error), isError: true });
      }
    }
  }
  throw new Error(`the model was still calling tools after ${MAX_TURNS} turns`);
}

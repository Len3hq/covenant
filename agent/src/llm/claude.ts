import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmConversation, LlmTurn, ToolResult, ToolSpec } from "./types.js";

const MAX_TOKENS = 16_000;
/** The models that accept server-side fallback when a safety classifier declines a request. */
const FALLBACK_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"];
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Claude, through Anthropic's SDK. */
export function claudeClient(config: {
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
}): LlmClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.fetcher ? { fetch: config.fetcher } : {}),
  });
  const fallback = FALLBACK_MODELS.includes(config.model)
    ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
    : {};

  return {
    start(system: string, user: string, tools: ToolSpec[]): LlmConversation {
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: user }];
      const specs = tools.map(({ name, description, parameters }) => ({
        name,
        description,
        input_schema: parameters as Anthropic.Beta.BetaTool["input_schema"],
      }));
      return {
        async next(results: ToolResult[]): Promise<LlmTurn> {
          if (results.length > 0) {
            messages.push({
              role: "user",
              content: results.map(({ id, content, isError }) => ({
                type: "tool_result" as const,
                tool_use_id: id,
                content,
                is_error: isError,
              })),
            });
          }
          for (;;) {
            const response = await client.beta.messages.create({
              model: config.model,
              max_tokens: MAX_TOKENS,
              system,
              tools: specs,
              messages,
              ...fallback,
            });
            if (response.stop_reason === "refusal") {
              throw new Error("the model declined this request");
            }
            // The whole content goes back, because thinking blocks must be replayed unchanged.
            messages.push({ role: "assistant", content: response.content });
            if (response.stop_reason === "pause_turn") continue;
            let text = "";
            const calls: LlmTurn["calls"] = [];
            for (const block of response.content) {
              if (block.type === "text") text += block.text;
              if (block.type === "tool_use") {
                calls.push({ id: block.id, name: block.name, input: block.input });
              }
            }
            return { text, calls };
          }
        },
      };
    },
  };
}

import { claudeClient } from "./claude.js";
import { openAiClient } from "./openai.js";
import type { LlmClient } from "./types.js";

export type { LlmClient, LlmConversation, LlmTurn, ToolCall, ToolResult, ToolSpec } from "./types.js";

/**
 * Picks the provider from the model's name: `claude-*` uses Anthropic's SDK and ignores `baseUrl`,
 * and anything else uses the OpenAI-compatible API at `baseUrl`.
 */
export function createLlm(config: {
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}): LlmClient {
  const { model, apiKey, baseUrl } = config;
  if (!model) throw new Error("LLM_MODEL is not set");
  if (!apiKey) throw new Error("LLM_API_KEY is not set");
  if (model.startsWith("claude-")) return claudeClient({ apiKey, model });
  if (!baseUrl) throw new Error(`LLM_BASE_URL is not set, and ${model} isn't a Claude model`);
  return openAiClient({ baseUrl, apiKey, model });
}

import { z } from "zod";
import { withRetry } from "@covenant/sdk";
import type { LlmClient, LlmConversation, LlmTurn, ToolResult, ToolSpec } from "./types.js";

const REQUEST_TIMEOUT_MS = 120_000;

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.looseObject({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              // Loose, because the model's message goes back to it exactly as it came.
              z.looseObject({
                id: z.string(),
                function: z.looseObject({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
});

/** A model's arguments that aren't JSON go to the tool's schema check, which reports them. */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Any OpenAI-compatible chat API: OpenAI, NEAR AI Cloud and others, chosen by `baseUrl`. */
export function openAiClient(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
}): LlmClient {
  const fetcher = config.fetcher ?? fetch;
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const request = async (body: unknown) => {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`LLM returned ${response.status}: ${await response.text()}`);
    return responseSchema.parse(await response.json());
  };

  return {
    start(system: string, user: string, tools: ToolSpec[]): LlmConversation {
      const messages: unknown[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      const specs = tools.map(({ name, description, parameters }) => ({
        type: "function",
        function: { name, description, parameters },
      }));
      return {
        async next(results: ToolResult[]): Promise<LlmTurn> {
          for (const { id, content } of results) {
            messages.push({ role: "tool", tool_call_id: id, content });
          }
          const { choices } = await withRetry(() =>
            request({ model: config.model, messages, tools: specs }),
          );
          const message = choices[0]?.message;
          if (!message) throw new Error("LLM returned no message");
          messages.push(message);
          return {
            text: message.content ?? "",
            calls: (message.tool_calls ?? []).map((call) => ({
              id: call.id,
              name: call.function.name,
              input: parseArguments(call.function.arguments),
            })),
          };
        },
      };
    },
  };
}

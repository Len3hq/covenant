import { describe, expect, it } from "vitest";
import { claudeClient } from "./claude.js";
import { createLlm } from "./index.js";
import { openAiClient } from "./openai.js";

const tools = [{ name: "pay", description: "Pays", parameters: { type: "object" } }];

function recorder(replies: unknown[]) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(replies.shift()), {
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, fetcher };
}

describe("createLlm", () => {
  it("needs a model and a key, and a base URL for anything but Claude", () => {
    expect(() => createLlm({ apiKey: "k" })).toThrow("LLM_MODEL");
    expect(() => createLlm({ model: "m" })).toThrow("LLM_API_KEY");
    expect(() => createLlm({ model: "m", apiKey: "k" })).toThrow("LLM_BASE_URL");
    expect(createLlm({ model: "claude-opus-5-5", apiKey: "k" })).toBeDefined();
    expect(createLlm({ model: "m", apiKey: "k", baseUrl: "https://x/v1" })).toBeDefined();
  });
});

describe("openAiClient", () => {
  it("runs a tool round trip in the chat completions format", async () => {
    const { requests, fetcher } = recorder([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "pay", arguments: '{"a":1}' } }],
            },
          },
        ],
      },
      { choices: [{ message: { role: "assistant", content: "Done" } }] },
    ]);
    const llm = openAiClient({ baseUrl: "https://llm.example/v1/", apiKey: "secret", model: "m", fetcher });
    const conversation = llm.start("sys", "user", tools);

    const first = await conversation.next([]);
    expect(first.calls).toEqual([{ id: "c1", name: "pay", input: { a: 1 } }]);
    const second = await conversation.next([{ id: "c1", content: "ok", isError: false }]);
    expect(second).toEqual({ text: "Done", calls: [] });

    expect(requests[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(requests[0]?.body.tools).toEqual([
      { type: "function", function: { name: "pay", description: "Pays", parameters: { type: "object" } } },
    ]);
    const messages = requests[1]?.body.messages as { role: string; tool_call_id?: string }[];
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[3]?.tool_call_id).toBe("c1");
    // Everything the model sent goes back unchanged, or the API refuses the conversation.
    expect((messages[2] as unknown as { tool_calls: { type: string }[] }).tool_calls[0]?.type).toBe("function");
  });

  it("passes arguments that aren't JSON on, for the tool's schema to refuse", async () => {
    const { fetcher } = recorder([
      {
        choices: [
          { message: { tool_calls: [{ id: "c", function: { name: "pay", arguments: "not json" } }] } },
        ],
      },
    ]);
    const llm = openAiClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetcher });
    expect((await llm.start("s", "u", tools).next([])).calls[0]?.input).toBe("not json");
  });
});

describe("claudeClient", () => {
  const message = (content: unknown[], stop_reason: string) => ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("runs a tool round trip, replaying the model's whole turn", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const { requests, fetcher } = recorder([
      message([thinking, { type: "tool_use", id: "t1", name: "pay", input: { a: 1 } }], "tool_use"),
      message([{ type: "text", text: "Done" }], "end_turn"),
    ]);
    const conversation = claudeClient({ apiKey: "k", model: "claude-opus-5-5", fetcher }).start("sys", "user", tools);

    expect((await conversation.next([])).calls).toEqual([{ id: "t1", name: "pay", input: { a: 1 } }]);
    const last = await conversation.next([{ id: "t1", content: "failed", isError: true }]);
    expect(last).toEqual({ text: "Done", calls: [] });

    expect(requests[0]?.body).toMatchObject({
      model: "claude-opus-5-5",
      system: "sys",
      fallbacks: "default",
      tools: [{ name: "pay", input_schema: { type: "object" } }],
    });
    const messages = requests[1]?.body.messages as { role: string; content: unknown }[];
    expect((messages[1]?.content as unknown[])[0]).toEqual(thinking);
    expect(messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "failed", is_error: true },
    ]);
  });

  it("asks for fallbacks only on models that accept them", async () => {
    const { requests, fetcher } = recorder([message([{ type: "text", text: "Hi" }], "end_turn")]);
    await claudeClient({ apiKey: "k", model: "claude-haiku-5-5", fetcher }).start("s", "u", tools).next([]);
    expect(requests[0]?.body.fallbacks).toBeUndefined();
  });

  it("reports a refusal as an error, and continues a paused turn", async () => {
    const refused = recorder([message([], "refusal")]);
    const conversation = claudeClient({ apiKey: "k", model: "claude-haiku-5-5", fetcher: refused.fetcher }).start("s", "u", tools);
    await expect(conversation.next([])).rejects.toThrow("declined");

    const paused = recorder([
      message([{ type: "text", text: "Working" }], "pause_turn"),
      message([{ type: "text", text: "Done" }], "end_turn"),
    ]);
    const resumed = claudeClient({ apiKey: "k", model: "claude-haiku-5-5", fetcher: paused.fetcher }).start("s", "u", tools);
    expect((await resumed.next([])).text).toBe("Done");
    expect(paused.requests).toHaveLength(2);
  });
});

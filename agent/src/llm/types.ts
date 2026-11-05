/** A tool as the model sees it. `parameters` is a JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Unvalidated: the caller checks it against the tool's schema. */
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export interface LlmTurn {
  text: string;
  /** Empty when the model has finished. */
  calls: ToolCall[];
}

export interface LlmConversation {
  /** Sends the results of the last turn's calls, or nothing on the first turn. */
  next(results: ToolResult[]): Promise<LlmTurn>;
}

export interface LlmClient {
  start(system: string, user: string, tools: ToolSpec[]): LlmConversation;
}

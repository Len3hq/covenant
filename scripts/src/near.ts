const CALL_FUNCTION = "call_function";

/** Calls a contract view method over JSON-RPC. */
export async function viewCall<T>(
  rpcUrl: string,
  accountId: string,
  method: string,
  args: unknown,
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "covenant",
      method: "query",
      params: {
        request_type: CALL_FUNCTION,
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = (await response.json()) as {
    error?: unknown;
    result?: { result?: number[]; error?: string };
  };
  const bytes = body.result?.result;
  if (!bytes) throw new Error(`${method} failed: ${JSON.stringify(body.error ?? body.result)}`);
  return JSON.parse(Buffer.from(bytes).toString()) as T;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

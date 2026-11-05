import { execFileSync } from "node:child_process";

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

/** Calls a method on the deployed vault through the NEAR CLI, which holds the signer's key. */
export function callVault(signer: string, method: string, args: unknown): void {
  execFileSync(
    "near",
    [
      "contract",
      "call-function",
      "as-transaction",
      requireEnv("VAULT_ACCOUNT_ID"),
      method,
      "json-args",
      JSON.stringify(args),
      "prepaid-gas",
      "30 Tgas",
      "attached-deposit",
      "0 NEAR",
      "sign-as",
      signer,
      "network-config",
      requireEnv("NEAR_NETWORK"),
      "sign-with-legacy-keychain",
      "send",
    ],
    { stdio: "inherit" },
  );
}

import { localRemoteSigner, type AgentCall, type RemoteSigner } from "@len3hq/covenant-sdk";
import { KeyPair, type KeyPairString } from "near-api-js";
import { readFileSync, writeFileSync } from "node:fs";
import type { Grant } from "./grant.js";

/** Where hosted agents' key lives. Only its public key ever reaches this process. */
export interface KeyHolder {
  publicKey(): Promise<string>;
  /** A signer for one grant's agent: the key holder refuses calls the grant doesn't cover. */
  signer(grant: Grant, publicKey: string): RemoteSigner;
}

interface CallAnswer {
  status?: string;
  output?: unknown;
  error?: unknown;
}

/** The key holder in OutLayer's enclave, over its HTTPS API (hosted/enclave). */
export function outlayerKeyHolder(options: {
  /** `https://api.outlayer.ai`, or the testnet API. */
  apiUrl: string;
  /** `<owner>/<project>`. */
  project: string;
  paymentKey: string;
  fetcher?: typeof fetch;
}): KeyHolder {
  const fetcher = options.fetcher ?? fetch;
  const call = async (input: object, timeoutMs?: number): Promise<Record<string, unknown>> => {
    const response = await fetcher(`${options.apiUrl}/call/${options.project}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment-key": options.paymentKey },
      body: JSON.stringify({ input }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const answer = (await response.json().catch(() => ({}))) as CallAnswer;
    if (!response.ok || answer.status !== "completed") {
      throw new Error(`the key holder didn't answer (${response.status}): ${JSON.stringify(answer.error ?? answer)}`);
    }
    const output = (typeof answer.output === "string" ? JSON.parse(answer.output) : answer.output) as Record<string, unknown>;
    if (typeof output.error === "string") throw new Error(`the key holder refused: ${output.error}`);
    return output;
  };
  let publicKey: Promise<string> | undefined;
  return {
    publicKey() {
      // Asked once, since it never changes; a failure isn't kept, so the next call asks again.
      // Bounded, so a stuck enclave fails fast instead of holding every waiting request for a minute.
      publicKey ??= call({ operation: "public_key" }, 30_000)
        .then((output) => String(output.public_key))
        .catch((error: unknown) => {
          publicKey = undefined;
          throw error;
        });
      return publicKey;
    },
    signer(grant, key) {
      return {
        publicKey: key,
        async sign(agentCall: AgentCall) {
          const output = await call({ operation: "sign_call", call: agentCall, grant });
          return Buffer.from(String(output.signature), "base64");
        },
      };
    },
  };
}

/**
 * The key holder, with its public key known ahead of time. Asking the enclave for it takes from a
 * few seconds to over a minute, and fails now and then; until it answers, the connector can serve
 * nothing. The key never changes, so it comes from `known` (the AGENT_PUBLIC_KEY setting) or the
 * file it was saved to after the first answer, and the enclave is asked only when neither has it.
 */
export function withKnownPublicKey(
  holder: KeyHolder,
  options: { known?: string; file: string; read?: (file: string) => string; write?: (file: string, value: string) => void },
): KeyHolder {
  const read = options.read ?? ((file: string) => readFileSync(file, "utf8"));
  const write = options.write ?? ((file: string, value: string) => writeFileSync(file, value));
  const valid = (key: string | undefined) => (key && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key) ? key : undefined);
  let saved: string | undefined;
  try {
    saved = valid(read(options.file).trim());
  } catch {
    // Not saved yet.
  }
  const known = valid(options.known) ?? saved;
  let asked: Promise<string> | undefined;
  return {
    publicKey() {
      if (known) return Promise.resolve(known);
      asked ??= holder.publicKey().then(
        (key) => {
          try {
            write(options.file, key);
          } catch (error) {
            console.error(JSON.stringify({ step: "public_key_not_saved", error: String(error) }));
          }
          return key;
        },
        (error: unknown) => {
          asked = undefined;
          throw error;
        },
      );
      return asked;
    },
    signer: (grant, key) => holder.signer(grant, key),
  };
}

/**
 * A key holder in this process, for running the connector without OutLayer. It skips the
 * enclave's grant checks, so it's for development only, with a key that holds nothing.
 */
export function localKeyHolder(secret: string): KeyHolder {
  const publicKey = KeyPair.fromString(secret as KeyPairString).getPublicKey().toString();
  return {
    publicKey: async () => publicKey,
    signer: () => localRemoteSigner(secret),
  };
}

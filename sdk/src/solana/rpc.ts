import { base58, base64 } from "@scure/base";
import { withRetry } from "../retry.js";
import { NONCE_ACCOUNT_LEN, TOKEN_PROGRAM } from "./message.js";

const CONFIRM_POLL_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 90_000;
/** Version 1, initialized: what a durable nonce account's first eight bytes say. */
const NONCE_INITIALIZED = [1, 0, 0, 0, 1, 0, 0, 0];

export interface NonceState {
  authority: Uint8Array;
  /** The value the next message uses in place of a recent blockhash. */
  nonce: Uint8Array;
}

interface AccountInfo {
  data: [string, "base64"];
  owner: string;
  lamports: number;
}

/** The few Solana JSON-RPC calls the vault needs, over fetch. */
export class SolanaRpc {
  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    return withRetry(async () => {
      const response = await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result as T;
    });
  }

  private async account(address: Uint8Array): Promise<AccountInfo | null> {
    const result = await this.call<{ value: AccountInfo | null }>("getAccountInfo", [
      base58.encode(address),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    return result.value;
  }

  async nonce(account: Uint8Array): Promise<NonceState> {
    const info = await this.account(account);
    if (!info) throw new Error(`nonce account ${base58.encode(account)} doesn't exist`);
    const data = base64.decode(info.data[0]);
    if (data.length !== NONCE_ACCOUNT_LEN || NONCE_INITIALIZED.some((byte, i) => data[i] !== byte)) {
      throw new Error(`${base58.encode(account)} isn't an initialized nonce account`);
    }
    return { authority: data.slice(8, 40), nonce: data.slice(40, 72) };
  }

  /** Whether this address is an SPL token account, rather than a wallet. */
  async isTokenAccount(address: Uint8Array): Promise<boolean> {
    const info = await this.account(address);
    return info?.owner === base58.encode(TOKEN_PROGRAM);
  }

  async balance(address: Uint8Array): Promise<bigint> {
    const result = await this.call<{ value: number }>("getBalance", [
      base58.encode(address),
      { commitment: "confirmed" },
    ]);
    return BigInt(result.value);
  }

  /** Zero for an account that doesn't exist yet. */
  async tokenBalance(account: Uint8Array): Promise<bigint> {
    if (!(await this.account(account))) return 0n;
    const result = await this.call<{ value: { amount: string } }>("getTokenAccountBalance", [
      base58.encode(account),
      { commitment: "confirmed" },
    ]);
    return BigInt(result.value.amount);
  }

  async rentExempt(space: number): Promise<bigint> {
    return BigInt(await this.call<number>("getMinimumBalanceForRentExemption", [space]));
  }

  async latestBlockhash(): Promise<Uint8Array> {
    const result = await this.call<{ value: { blockhash: string } }>("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    return base58.decode(result.value.blockhash);
  }

  /** Sends a signed transaction and waits until it's confirmed, so its nonce has advanced. */
  async sendAndConfirm(transaction: Uint8Array): Promise<string> {
    const signature = await this.call<string>("sendTransaction", [
      base64.encode(transaction),
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]);
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    for (;;) {
      const result = await this.call<{
        value: ({ err: unknown; confirmationStatus?: string } | null)[];
      }>("getSignatureStatuses", [[signature]]);
      const status = result.value[0];
      if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return signature;
      }
      if (Date.now() > deadline) throw new Error(`${signature} wasn't confirmed in time`);
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
    }
  }
}

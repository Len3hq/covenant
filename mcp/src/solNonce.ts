import {
  createNonceAccount,
  NeedsFunding,
  SolanaRpc,
  solanaKeypair,
  solanaKeypairFromSecret,
  solanaSecret,
  TESTNET,
  type SolanaKeypair,
} from "@len3hq/covenant-sdk";
import { base58 } from "@scure/base";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/*
 * `covenant-mcp sol-nonce`: creates a durable nonce account for the vault's Solana payments, with no
 * clone of the repo. A funder key, kept on this machine, pays the rent; the vault is the nonce's
 * authority, so the funder can never use it.
 */

const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface SolNonceOptions {
  env: NodeJS.ProcessEnv;
  home?: string;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
}

/** Where the funder's key lives: Solana CLI's keypair format, so `solana` can use it too. */
export const funderFile = (home: string) => join(home, ".covenant", "sol-funder.json");

/** `SOL_FUNDER_KEY` if set, else the saved funder, else a new one, saved. */
export function loadFunder(env: NodeJS.ProcessEnv, home: string): { funder: SolanaKeypair; from: string; created: boolean } {
  if (env.SOL_FUNDER_KEY) {
    return { funder: solanaKeypairFromSecret(base58.decode(env.SOL_FUNDER_KEY)), from: "SOL_FUNDER_KEY", created: false };
  }
  const file = funderFile(home);
  if (existsSync(file)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]);
    return { funder: solanaKeypairFromSecret(secret), from: file, created: false };
  }
  const funder = solanaKeypair();
  mkdirSync(join(home, ".covenant"), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify([...solanaSecret(funder)]), { mode: 0o600 });
  chmodSync(file, 0o600);
  return { funder, from: file, created: true };
}

/** The vault's Solana address, from a view call that needs no key. */
export async function vaultSolAddress(rpcUrl: string, vault: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "sol-nonce",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: vault, method_name: "get_addresses", args_base64: "" },
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { result?: { result?: number[] }; error?: { message?: string } };
  const bytes = body.result?.result;
  if (!bytes) throw new Error(`couldn't read ${vault}'s addresses: ${body.error?.message ?? `HTTP ${response.status}`}`);
  const { sol_address } = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as { sol_address?: string };
  if (!sol_address) throw new Error(`${vault} runs code from before Solana support`);
  return base58.decode(sol_address);
}

const sol = (lamports: bigint) => {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
};

/** Runs the command; the answer is its exit code. */
export async function runSolNonce({ env, home = homedir(), fetcher = fetch, log = console.log }: SolNonceOptions): Promise<number> {
  const vault = env.VAULT_ACCOUNT_ID;
  if (!vault) {
    log("Set VAULT_ACCOUNT_ID to the vault, such as VAULT_ACCOUNT_ID=acme.vaults-v3.len3hq.testnet npx -y @len3hq/covenant-mcp@latest sol-nonce");
    return 1;
  }
  if (!vault.endsWith(".testnet")) {
    log(`${vault} isn't a testnet account. This release pays on testnets only.`);
    return 1;
  }
  const authority = await vaultSolAddress(env.NEAR_RPC_URL ?? TESTNET.nearRpcUrl, vault, fetcher);
  const { funder, from, created } = loadFunder(env, home);
  const rpc = new SolanaRpc(env.SOL_RPC_URL ?? TESTNET.solRpcUrl, fetcher);
  try {
    const { account, signature } = await createNonceAccount(rpc, funder, authority);
    const existing = (env.SOL_NONCE_ACCOUNTS ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    const accounts = [...existing, base58.encode(account)].join(",");
    log(`Created nonce account ${base58.encode(account)} for ${vault}, with the vault as its authority.`);
    log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    log("");
    log("Add this to the env of your app's Covenant config, next to VAULT_ACCOUNT_ID:");
    log(`SOL_NONCE_ACCOUNTS=${accounts}`);
    log("");
    log("Each account carries one Solana payment at a time. Run this again for more, with SOL_NONCE_ACCOUNTS set, to add to the list.");
    return 0;
  } catch (error) {
    if (!(error instanceof NeedsFunding)) throw error;
    log(
      `A funder key pays the account's rent; ${created ? "a new one was saved in" : "this one is from"} ${from}. ` +
        `It holds ${sol(error.has)} SOL and needs ${sol(error.needed)} SOL.`,
    );
    log(`Send devnet SOL to ${base58.encode(error.funder)}, for example from https://faucet.solana.com, then run this again.`);
    return 1;
  }
}

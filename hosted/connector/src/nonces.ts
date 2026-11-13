import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { base58 } from "@scure/base";
import {
  Connection,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

/*
 * Durable nonce accounts for hosted vaults. A Solana payment held for a veto needs one, so it can
 * still land after the wait. Each account's authority is the vault's own Solana address, so only
 * the vault can advance it; the funder below only pays its rent and holds no power over it.
 */

/** Each vault's nonce accounts, on the connector's volume. */
export class NonceStore {
  constructor(private readonly dir: string) {}

  list(vault: string): string[] {
    try {
      return JSON.parse(readFileSync(this.path(vault), "utf8")) as string[];
    } catch {
      return [];
    }
  }

  add(vault: string, account: string): void {
    const accounts = [...new Set([...this.list(vault), account])];
    const temporary = `${this.path(vault)}.tmp`;
    writeFileSync(temporary, JSON.stringify(accounts, null, 2));
    renameSync(temporary, this.path(vault));
  }

  private path(vault: string) {
    return join(this.dir, `${vault}-nonces.json`);
  }
}

/** Creates one nonce account whose authority is `authority`, and answers its address. */
export type NonceCreator = (authority: string) => Promise<string>;

/** A creator that pays rent from a devnet funder key, as `make sol-nonce` does. */
export function web3NonceCreator(rpcUrl: string, funderSecret: string): NonceCreator {
  const connection = new Connection(rpcUrl, "confirmed");
  const funder = Keypair.fromSecretKey(base58.decode(funderSecret));
  return async (authority) => {
    const nonce = Keypair.generate();
    const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
    const tx = new Transaction().add(
      ...SystemProgram.createNonceAccount({
        fromPubkey: funder.publicKey,
        noncePubkey: nonce.publicKey,
        authorizedPubkey: new PublicKey(authority),
        lamports: rent,
      }).instructions,
    );
    await sendAndConfirmTransaction(connection, tx, [funder, nonce]);
    return nonce.publicKey.toBase58();
  };
}

/**
 * Tops a vault up to `want` nonce accounts, one creation at a time per vault, so two requests at
 * once don't create four.
 */
export function nonceKeeper(options: { store: NonceStore; create: NonceCreator; want?: number }) {
  const want = options.want ?? 2;
  const running = new Map<string, Promise<void>>();
  return (vault: string, solAddress: () => Promise<string | undefined>): Promise<void> => {
    const current = running.get(vault);
    if (current) return current;
    const job = (async () => {
      if (options.store.list(vault).length >= want) return;
      const authority = await solAddress();
      if (!authority) return; // The vault predates Solana support.
      while (options.store.list(vault).length < want) {
        options.store.add(vault, await options.create(authority));
      }
    })().finally(() => running.delete(vault));
    running.set(vault, job);
    return job;
  };
}

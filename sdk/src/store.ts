import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Transaction } from "bitcoinjs-lib";
import type { SignedQuote, SwapTerms } from "./tidepool.js";
import type { SpendOutcome } from "./vault.js";

/** A swap's quote and terms, kept with a spend that pays its deposit address. */
export interface SwapPart {
  quote?: SignedQuote;
  swap?: SwapTerms;
}

/** Enough to finish a spend after a restart, without proposing it again. */
export type Prepared = SwapPart &
  (
    | { chain: "Bitcoin"; unsignedHex: string; prevTxs: string[]; inputValues: string[] }
    | { chain: "Evm"; unsignedHex: string }
    /** `unsignedHex` is the legacy message, which is what Ed25519 signs. */
    | { chain: "Solana"; unsignedHex: string; nonceAccount: string }
  );

export type SpendStatus =
  | "prepared" // Built, and not yet sent to NEAR.
  | "proposing" // Sent to NEAR, with its hash recorded. Never send it again: look the hash up.
  | "queued"
  | "executing"
  | "signed" // The signed chain transaction is recorded, and may or may not have landed.
  | "broadcast"
  | "rejected"
  | "failed"; // The contract panicked, so nothing changed and it's safe to try again.

export interface SpendRecord {
  key: string;
  status: SpendStatus;
  description: string;
  prepared: Prepared;
  nearTx?: string;
  id?: string;
  executableAt?: string;
  error?: string;
  signedHex?: string;
  chainTx?: string;
  /** For a swap, Tidepool's last status for it, such as `PROCESSING` or `SUCCESS`. */
  swapStatus?: string;
}

/**
 * The record of what's been paid, written before each step so a restart never pays twice. It holds
 * no secrets: only transactions the chains and NEAR already see.
 */
export class SpendStore {
  private readonly path: string;
  private readonly records: Map<string, SpendRecord>;

  constructor(path: string) {
    this.path = path;
    const saved = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SpendRecord[]) : [];
    this.records = new Map(saved.map((record) => [record.key, record]));
  }

  get(key: string): SpendRecord | undefined {
    return this.records.get(key);
  }

  all(): SpendRecord[] {
    return [...this.records.values()];
  }

  byId(id: string): SpendRecord | undefined {
    return [...this.records.values()].find((record) => record.id === id);
  }

  /**
   * Coins that an unfinished Bitcoin spend will use, as `txid:vout`. A new payment must leave them
   * alone, or the queued spend would be signed and charged but couldn't land.
   */
  heldCoins(): Set<string> {
    const finished = new Set(["broadcast", "rejected", "failed"]);
    const held = new Set<string>();
    for (const { status, prepared } of this.records.values()) {
      if (prepared.chain !== "Bitcoin" || finished.has(status)) continue;
      for (const input of Transaction.fromHex(prepared.unsignedHex).ins) {
        held.add(`${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`);
      }
    }
    return held;
  }

  /** Nonce accounts that an unfinished Solana spend's message advances, for the same reason. */
  heldNonces(): Set<string> {
    const finished = new Set(["broadcast", "rejected", "failed"]);
    const held = new Set<string>();
    for (const { status, prepared } of this.records.values()) {
      if (prepared.chain === "Solana" && !finished.has(status)) held.add(prepared.nonceAccount);
    }
    return held;
  }

  /** Written to a temporary file first, so a crash can't leave half a record behind. */
  put(record: SpendRecord): void {
    this.records.set(record.key, record);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.records.values()], null, 2));
    renameSync(temporary, this.path);
  }
}

export type { SpendOutcome };

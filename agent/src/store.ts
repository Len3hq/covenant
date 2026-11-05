import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SpendOutcome } from "./vault.js";

/** Enough to finish a spend after a restart, without proposing it again. */
export type Prepared =
  | { chain: "Bitcoin"; unsignedHex: string; prevTxs: string[]; inputValues: string[] }
  | { chain: "Evm"; unsignedHex: string };

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

  byId(id: string): SpendRecord | undefined {
    return [...this.records.values()].find((record) => record.id === id);
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

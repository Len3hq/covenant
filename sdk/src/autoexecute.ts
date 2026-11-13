import type { Covenant, DueResult } from "./covenant.js";

export interface AutoExecuteOptions {
  /** How often to look for held payments whose wait is over. Defaults to 30 seconds. */
  intervalMs?: number;
  /** Told about each payment it sent or couldn't send, and about a round that failed. */
  onResult?(result: DueResult | { error: string }): void;
}

/**
 * Sends a wallet's held payments as their waits end, for as long as the process runs: once now,
 * then every `intervalMs`. Rounds never overlap. Returns a function that stops it. The timer
 * doesn't keep the process alive on its own.
 */
export function startAutoExecute(wallet: Pick<Covenant, "executeDue">, options: AutoExecuteOptions = {}): () => void {
  let running = false;
  const round = async () => {
    if (running) return;
    running = true;
    try {
      for (const result of await wallet.executeDue()) options.onResult?.(result);
    } catch (error) {
      options.onResult?.({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };
  void round();
  const timer = setInterval(() => void round(), options.intervalMs ?? 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

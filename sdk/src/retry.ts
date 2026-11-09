const ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

/**
 * Retries with backoff. Use only for calls that are safe to repeat: reads, and broadcasts of a
 * transaction that's already signed. Never wrap a proposal in this.
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

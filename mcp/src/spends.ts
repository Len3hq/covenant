import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where payments are recorded. `npx` starts in a different folder each time, so the default lives
 * in the home folder, one file per vault. The record holds no secrets, but it is what stops the
 * same reference paying twice, so it is kept private to the user.
 */
export function spendsFile(vault: string, configured?: string, home: string = homedir()): string {
  if (configured) return configured;
  const folder = join(home, ".covenant");
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `${vault.replace(/[^a-z0-9._-]/gi, "_")}-spends.json`);
  if (existsSync(file)) chmodSync(file, 0o600);
  return file;
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAutoExecute } from "./autoexecute.js";
import { Covenant } from "./covenant.js";
import { SpendStore, type Prepared } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const prepared: Prepared = { chain: "Evm", unsignedHex: "0x02" };

/** A wallet over a fake vault whose queue holds `queue`, with `records` already in its spends file. */
function walletWith(queue: { id: string; executable_at: string }[], records: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "covenant-"));
  dirs.push(dir);
  const spendsFile = join(dir, "spends.json");
  const store = new SpendStore(spendsFile);
  for (const id of records) store.put({ key: `k${id}`, id, description: "", status: "queued", prepared });
  const execute = vi.fn(async () => ({ outcome: { Rejected: "PerTxCapExceeded" as const }, nearTx: "h" }));
  const vault = { queue: vi.fn(async () => queue), execute };
  const make = Covenant as unknown as new (options: object, world: object) => Covenant;
  const wallet = new make({ vault: "v", agentAccount: "a", agentKey: "k", spendsFile, log: () => {} }, { vault, broadcast: {} });
  return { wallet, execute, read: () => new SpendStore(spendsFile) };
}

describe("Covenant.executeDue", () => {
  it("sends only the held payments it made whose wait is over, and settles vetoed ones", async () => {
    const { wallet, execute, read } = walletWith(
      [
        { id: "7", executable_at: ns(NOW - 1_000) }, // due, ours
        { id: "8", executable_at: ns(NOW + 60_000) }, // still waiting
        { id: "9", executable_at: ns(NOW - 1_000) }, // due, made by someone else
      ],
      ["6", "7", "8"], // 6 was vetoed: it's no longer in the vault's queue
    );
    const results = await wallet.executeDue(NOW);
    expect(execute.mock.calls.map(([id]) => id)).toEqual(["7"]);
    expect(results).toMatchObject([{ id: "7", result: { status: "rejected", error: "PerTxCapExceeded" } }]);
    expect(read().byId("6")).toMatchObject({ status: "failed" });
    expect(read().byId("8")).toMatchObject({ status: "queued" });
  });

  it("asks the vault nothing when no payment of its own is held", async () => {
    const { wallet, execute } = walletWith([{ id: "9", executable_at: "0" }], []);
    expect(await wallet.executeDue(NOW)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("startAutoExecute", () => {
  it("runs at once and then on a timer, never two rounds at the same time, until stopped", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const executeDue = vi.fn(() => new Promise<[]>((resolve) => (release = () => resolve([]))));
    const stop = startAutoExecute({ executeDue }, { intervalMs: 1_000 });
    expect(executeDue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000); // the first round is still running
    expect(executeDue).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(executeDue).toHaveBeenCalledTimes(2);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executeDue).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("reports a failed round and keeps going", async () => {
    vi.useFakeTimers();
    const onResult = vi.fn();
    const executeDue = vi.fn().mockRejectedValueOnce(new Error("RPC down")).mockResolvedValue([]);
    const stop = startAutoExecute({ executeDue }, { intervalMs: 1_000, onResult });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onResult).toHaveBeenCalledWith({ error: "RPC down" });
    expect(executeDue).toHaveBeenCalledTimes(2);
    stop();
    vi.useRealTimers();
  });
});

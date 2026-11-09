import { describe, expect, it, vi } from "vitest";
import { Mempool } from "./bitcoin/mempool.js";
import { preparePayment, type PrepareDeps } from "./payments.js";

describe("preparePayment", () => {
  // The bug-bash fix of 6 Nov spread the real client, which dropped its methods. Tests used plain
  // objects, so they passed while every live Bitcoin payment from the agent failed.
  it("still reaches every method of a real Mempool after leaving held coins out", async () => {
    const mempool = new Mempool("https://mempool.invalid");
    const feeRate = vi.spyOn(mempool, "feeRate").mockResolvedValue(2n);
    vi.spyOn(mempool, "spendableUtxos").mockResolvedValue([]);
    const deps = {
      vault: {
        btcPubkey: async () => Buffer.from(`02${"11".repeat(32)}`, "hex"),
        btcLimits: async () => ({ maxInputs: 3, maxFeeRate: 50n }),
      },
      bitcoin: { vault: {} as never, mempool },
      chain: {} as never,
      usdc: "0x0000000000000000000000000000000000000000",
      heldCoins: () => new Set<string>(),
    } as unknown as PrepareDeps;
    deps.bitcoin.vault = deps.vault as never;
    // No coins, so it fails, but only after asking the real client for its fee rate.
    await expect(preparePayment(deps, "BTC", "tb1ql3d46g8n2ua8ulj8nu8fq8ulpm7vxfl6tjfxgs", 1000n)).rejects.toThrow();
    expect(feeRate).toHaveBeenCalled();
  });
});

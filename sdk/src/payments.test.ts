import { describe, expect, it, vi } from "vitest";
import { Mempool } from "./bitcoin/mempool.js";
import { parseTransaction, serializeTransaction } from "viem";
import { preparePayment, type PrepareDeps, type UnfinishedEvm } from "./payments.js";

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

describe("one Base payment at a time", () => {
  const vaultAddress = "0x00000000000000000000000000000000000000aa";
  const payee = "0x00000000000000000000000000000000000000bb";
  const unsigned = (nonce: number) =>
    serializeTransaction({ type: "eip1559", chainId: 84532, nonce, to: payee, value: 1n, gas: 21_000n });
  const deps = (unfinished: UnfinishedEvm[], queue: string[], next = 5) =>
    ({
      vault: { evmAddress: async () => vaultAddress, queue: async () => queue.map((id) => ({ id, executable_at: "0" })) },
      bitcoin: {} as never,
      chain: {
        chainId: 84532,
        pendingNonce: async () => next,
        fees: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      },
      usdc: payee,
      unfinishedEvm: () => unfinished,
    }) as unknown as PrepareDeps;
  const record = (status: string, nonce: number, id = "7") => ({
    id,
    status,
    description: "1 ETH to someone: INV-1",
    prepared: { unsignedHex: unsigned(nonce) },
  });

  it("refuses while another is queued in the vault, or signed and not yet landed", async () => {
    await expect(preparePayment(deps([record("queued", 5)], ["7"]), "ETH", payee, 1n)).rejects.toThrow(
      "Another Base payment (spend 7",
    );
    await expect(preparePayment(deps([record("signed", 5)], []), "ETH", payee, 1n)).rejects.toThrow("share a nonce");
  });

  it("goes ahead once the other was vetoed, or the chain is past its nonce", async () => {
    const vetoed = await preparePayment(deps([record("queued", 5)], []), "ETH", payee, 1n);
    expect(vetoed.chain).toBe("Evm");
    const dead = await preparePayment(deps([record("signed", 4)], []), "ETH", payee, 1n);
    expect(parseTransaction(dead.unsignedHex as `0x${string}`).nonce).toBe(5);
  });
});

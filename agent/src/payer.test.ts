import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, keccak256, serializeTransaction, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Payer } from "./payer.js";
import { SpendStore, type Prepared } from "./store.js";
import { ContractPanic, type AgentVault, type BeforeSend, type Proposed, type SpendOutcome } from "./vault.js";

const SECRET = new Uint8Array(32).fill(7);
const VAULT = publicKeyToAddress(bytesToHex(secp256k1.getPublicKey(SECRET, false)));
const UNSIGNED = serializeTransaction({
  type: "eip1559",
  chainId: 84532,
  nonce: 1,
  gas: 21_000n,
  maxFeePerGas: 6n,
  maxPriorityFeePerGas: 1n,
  to: `0x${"aa".repeat(20)}` as Address,
  value: 5n,
  accessList: [],
});
const PREPARED: Prepared = { chain: "Evm", unsignedHex: UNSIGNED };

function signed(id = "4"): SpendOutcome {
  const recovered = secp256k1.sign(hex.decode(keccak256(UNSIGNED).slice(2)), SECRET, {
    prehash: false,
    format: "recovered",
  });
  return {
    Signed: {
      id,
      signatures: [
        {
          big_r: { affine_point: `02${hex.encode(recovered.slice(1, 33))}` },
          s: { scalar: hex.encode(recovered.slice(33)) },
          recovery_id: recovered[0] ?? 0,
        },
      ],
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(propose: (beforeSend?: BeforeSend) => Promise<Proposed>) {
  const dir = mkdtempSync(join(tmpdir(), "covenant-"));
  dirs.push(dir);
  const path = join(dir, "spends.json");
  const vault = {
    evmAddress: async () => VAULT,
    btcPubkey: async () => new Uint8Array(),
    proposeEvm: vi.fn((_tx: Uint8Array, beforeSend?: BeforeSend) => propose(beforeSend)),
    execute: vi.fn((_id: string, beforeSend?: BeforeSend) => propose(beforeSend)),
    recover: vi.fn(async (nearTx: string): Promise<Proposed> => ({ outcome: signed(), nearTx })),
  };
  const broadcast = { bitcoin: vi.fn(async () => "txid"), evm: vi.fn<(signedHex: Hex) => Promise<string>>(async () => "0xhash") };
  const payer = () =>
    new Payer({
      vault: vault as unknown as AgentVault,
      store: new SpendStore(path),
      broadcast,
      log: () => undefined,
    });
  return { vault, broadcast, payer, path };
}

const prepare = async () => PREPARED;

describe("Payer", () => {
  it("signs, records and broadcasts a spend, with its explorer links", async () => {
    const h = harness(async (beforeSend) => {
      beforeSend?.("near-1");
      return { outcome: signed(), nearTx: "near-1" };
    });
    const result = await h.payer().spend("k", "pay", prepare);
    expect(result.status).toBe("broadcast");
    expect(h.broadcast.evm).toHaveBeenCalledOnce();
    expect(result.links.near).toBe("https://testnet.nearblocks.io/txns/near-1");
    expect(result.links.chain).toMatch(/^https:\/\/sepolia\.basescan\.org\/tx\/0x/);
  });

  it("never proposes or broadcasts a finished spend again, even after a restart", async () => {
    const h = harness(async () => ({ outcome: signed(), nearTx: "near-1" }));
    const first = await h.payer().spend("k", "pay", prepare);
    const again = await h.payer().spend("k", "pay", prepare);
    expect(again).toEqual(first);
    expect(h.vault.proposeEvm).toHaveBeenCalledOnce();
    expect(h.broadcast.evm).toHaveBeenCalledOnce();
  });

  it("looks up a proposal lost to a crash by its hash, and doesn't send it again", async () => {
    const h = harness(async (beforeSend) => {
      beforeSend?.("near-lost");
      throw new Error("connection lost");
    });
    await expect(h.payer().spend("k", "pay", prepare)).rejects.toThrow("connection lost");
    const result = await h.payer().spend("k", "pay", prepare);
    expect(h.vault.proposeEvm).toHaveBeenCalledOnce();
    expect(h.vault.recover).toHaveBeenCalledWith("near-lost");
    expect(result.status).toBe("broadcast");
  });

  it("broadcasts the same signed transaction again if the broadcast failed", async () => {
    const h = harness(async () => ({ outcome: signed(), nearTx: "near-1" }));
    h.broadcast.evm.mockRejectedValueOnce(new Error("RPC down"));
    await expect(h.payer().spend("k", "pay", prepare)).rejects.toThrow("RPC down");
    const result = await h.payer().spend("k", "pay", prepare);
    expect(h.vault.proposeEvm).toHaveBeenCalledOnce();
    expect(h.broadcast.evm).toHaveBeenCalledTimes(2);
    expect(h.broadcast.evm.mock.calls[0]).toEqual(h.broadcast.evm.mock.calls[1]);
    expect(result.status).toBe("broadcast");
  });

  it("treats a transaction the chain already has as sent", async () => {
    const h = harness(async () => ({ outcome: signed(), nearTx: "near-1" }));
    h.broadcast.evm.mockRejectedValueOnce(new Error("already known"));
    expect((await h.payer().spend("k", "pay", prepare)).status).toBe("broadcast");
  });

  it("won't broadcast a signature from the wrong key", async () => {
    const other = new Uint8Array(32).fill(9);
    const recovered = secp256k1.sign(hex.decode(keccak256(UNSIGNED).slice(2)), other, {
      prehash: false,
      format: "recovered",
    });
    const h = harness(async () => ({
      outcome: {
        Signed: {
          id: "1",
          signatures: [
            {
              big_r: { affine_point: `02${hex.encode(recovered.slice(1, 33))}` },
              s: { scalar: hex.encode(recovered.slice(33)) },
              recovery_id: recovered[0] ?? 0,
            },
          ],
        },
      },
      nearTx: "near-1",
    }));
    await expect(h.payer().spend("k", "pay", prepare)).rejects.toThrow("not the vault's");
    expect(h.broadcast.evm).not.toHaveBeenCalled();
  });

  it("reports a refusal, and doesn't try it again", async () => {
    const h = harness(async () => ({ outcome: { Rejected: "OutputNotWhitelisted" }, nearTx: "near-1" }));
    const result = await h.payer().spend("k", "pay", prepare);
    expect(result).toMatchObject({ status: "rejected", error: "OutputNotWhitelisted" });
    await h.payer().spend("k", "pay", prepare);
    expect(h.vault.proposeEvm).toHaveBeenCalledOnce();
    expect(h.broadcast.evm).not.toHaveBeenCalled();
  });

  it("allows another try after a contract panic, which changes nothing", async () => {
    let frozen = true;
    const h = harness(async () => {
      if (frozen) throw new ContractPanic('{"error":"Smart contract panicked: Frozen"}');
      return { outcome: signed(), nearTx: "near-2" };
    });
    expect(await h.payer().spend("k", "pay", prepare)).toMatchObject({ status: "failed", error: "Frozen" });
    frozen = false;
    expect((await h.payer().spend("k", "pay", prepare)).status).toBe("broadcast");
  });

  it("finishes a queued spend through execute, after a restart", async () => {
    const outcomes: SpendOutcome[] = [
      { Queued: { id: "9", executable_at: "100" } },
      { Rejected: "NotYetExecutable" },
      signed("9"),
    ];
    const h = harness(async () => ({ outcome: outcomes.shift() as SpendOutcome, nearTx: "near-q" }));
    expect(await h.payer().spend("k", "pay", prepare)).toMatchObject({ status: "queued", id: "9" });
    expect(h.broadcast.evm).not.toHaveBeenCalled();

    expect(await h.payer().execute("9")).toMatchObject({ status: "queued", error: "NotYetExecutable" });
    expect(h.broadcast.evm).not.toHaveBeenCalled();

    expect(await h.payer().execute("9")).toMatchObject({ status: "broadcast", id: "9" });
    expect(h.broadcast.evm).toHaveBeenCalledOnce();
    expect(h.vault.execute).toHaveBeenCalledTimes(2);
  });

  it("refuses to execute a spend it has no record of", async () => {
    const h = harness(async () => ({ outcome: signed(), nearTx: "n" }));
    await expect(h.payer().execute("404")).rejects.toThrow("no record");
  });
});

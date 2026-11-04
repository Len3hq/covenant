import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { address, networks, payments, Transaction } from "bitcoinjs-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpendOutcome, VaultClient } from "../vault.js";
import { payBitcoin, type PayDeps } from "./pay.js";
import { contractVsize, hash160, p2wpkhScript, stripWitness } from "./tx.js";
import { derEncode, normalizeS, type MpcSignature } from "./witness.js";

const SECRET = new Uint8Array(32).fill(7);
const PUBKEY = secp256k1.getPublicKey(SECRET, true);
const OWN_SCRIPT = p2wpkhScript(PUBKEY);
const ORDER = secp256k1.Point.Fn.ORDER;
const PAYEE_SCRIPT = Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(0xaa)]);
const payeeAddress = address.fromOutputScript(PAYEE_SCRIPT, networks.testnet);

/** A previous transaction paying the vault, with a witness as the block explorer returns it. */
function prevTx(salt: number, value: bigint): Transaction {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(new Uint8Array(32).fill(salt), 0, 0xffffffff);
  tx.addOutput(OWN_SCRIPT, value);
  tx.setWitness(0, [new Uint8Array(71).fill(1), new Uint8Array(33).fill(2)]);
  return tx;
}

const PREVS = [prevTx(1, 5_000n), prevTx(2, 500_000n), prevTx(3, 254_051n)];
const scriptCode = payments.p2pkh({ hash: hash160(PUBKEY) }).output as Uint8Array;

function mpcSign(
  tx: Transaction,
  index: number,
  value: bigint,
  highS = false,
): MpcSignature & { recovery_id: number } {
  const sighash = tx.hashForWitnessV0(index, scriptCode, value, 1);
  const compact = secp256k1.sign(sighash, SECRET, { prehash: false, format: "compact" });
  const r = compact.slice(0, 32);
  const s = compact.slice(32);
  const flipped = (ORDER - BigInt(`0x${hex.encode(s)}`)).toString(16).padStart(64, "0");
  return {
    big_r: { affine_point: `02${hex.encode(r)}` },
    s: { scalar: highS ? flipped : hex.encode(s) },
    recovery_id: 0,
  };
}

function deps(sign: (tx: Transaction, values: bigint[]) => SpendOutcome): {
  deps: PayDeps;
  broadcast: ReturnType<typeof vi.fn>;
  proposal: () => { tx: Transaction; prevTxs: Uint8Array[] };
} {
  const broadcast = vi.fn(async () => "broadcast-txid");
  let proposed: { tx: Transaction; prevTxs: Uint8Array[] } | undefined;
  const vault: VaultClient = {
    btcPubkey: async () => PUBKEY,
    btcLimits: async () => ({ maxInputs: 3, maxFeeRate: 50n }),
    evmAddress: async () => "0x",
    proposeEvm: async () => {
      throw new Error("not a Bitcoin proposal");
    },
    proposeBitcoin: async ({ tx, prevTxs }) => {
      const parsed = Transaction.fromBuffer(Buffer.from(tx));
      proposed = { tx: parsed, prevTxs };
      const values = prevTxs.map((prev, index) => {
        const vout = parsed.ins[index]?.index ?? 0;
        return Transaction.fromBuffer(Buffer.from(prev)).outs[vout]?.value ?? 0n;
      });
      return { outcome: sign(parsed, values), nearTx: "near-tx" };
    },
  };
  const byId = new Map(PREVS.map((tx) => [tx.getId(), tx.toHex()]));
  return {
    broadcast,
    proposal: () => {
      if (!proposed) throw new Error("nothing proposed");
      return proposed;
    },
    deps: {
      vault,
      mempool: {
        confirmedUtxos: async () =>
          PREVS.map((tx) => ({
            txid: tx.getId(),
            vout: 0,
            value: tx.outs[0]?.value ?? 0n,
          })),
        txHex: async (txid) => byId.get(txid) ?? "",
        feeRate: async () => 2n,
        broadcast,
      },
    },
  };
}

function honest(highS = false) {
  return (tx: Transaction, values: bigint[]): SpendOutcome => ({
    Signed: {
      id: "0",
      signatures: tx.ins.map((_, i) => mpcSign(tx, i, values[i] ?? 0n, highS)),
    },
  });
}

function broadcastTx(broadcast: ReturnType<typeof vi.fn>): Transaction {
  const call = broadcast.mock.calls[0] as unknown as [string];
  return Transaction.fromHex(call[0]);
}

describe("derEncode", () => {
  it("adds a zero byte when the high bit is set, and trims leading zeros", () => {
    const r = new Uint8Array(32).fill(0x80);
    const s = Uint8Array.from([0, 0, ...new Uint8Array(30).fill(0x11)]);
    const der = hex.encode(derEncode(r, s));
    expect(der).toBe(`3043022100${"80".repeat(32)}021e${"11".repeat(30)}`);
  });

  it("keeps a zero byte when trimming exposes a high bit", () => {
    const s = Uint8Array.from([0, 0x80, ...new Uint8Array(30).fill(0x11)]);
    const der = hex.encode(derEncode(new Uint8Array(32).fill(1), s));
    expect(der.endsWith(`022000 80${"11".repeat(30)}`.replace(" ", ""))).toBe(true);
  });
});

describe("normalizeS", () => {
  it("flips only a high s", () => {
    const low = new Uint8Array(32).fill(1);
    expect(normalizeS(low)).toBe(low);
    const high = hex.decode((ORDER - 5n).toString(16).padStart(64, "0"));
    expect(hex.encode(normalizeS(high))).toBe("05".padStart(64, "0"));
  });
});

describe("payBitcoin", () => {
  let run: ReturnType<typeof deps>;

  beforeEach(() => {
    run = deps(honest());
  });

  it("sends the contract a witness-free tx and witness-free prev txs", async () => {
    await payBitcoin(run.deps, payeeAddress, 20_000n);
    const { tx, prevTxs } = run.proposal();
    expect(tx.hasWitnesses()).toBe(false);
    expect(prevTxs[0]).toEqual(stripWitness(PREVS[1]?.toHex() ?? "", PREVS[1]?.getId() ?? ""));
    expect(Transaction.fromBuffer(Buffer.from(prevTxs[0] as Uint8Array)).hasWitnesses()).toBe(false);
  });

  it("uses the largest coin, pays the payee and returns the rest to the vault", async () => {
    const result = await payBitcoin(run.deps, payeeAddress, 20_000n);
    expect(result.status).toBe("broadcast");
    const tx = broadcastTx(run.broadcast);
    expect(tx.ins).toHaveLength(1);
    expect(tx.outs[0]?.value).toBe(20_000n);
    expect(hex.encode(tx.outs[0]?.script ?? new Uint8Array())).toBe(hex.encode(PAYEE_SCRIPT));
    expect(hex.encode(tx.outs[1]?.script ?? new Uint8Array())).toBe(hex.encode(OWN_SCRIPT));
    expect(tx.outs[1]?.value).toBe(480_000n - (result.status === "broadcast" ? result.fee : 0n));
  });

  it("broadcasts a valid witness for every input", async () => {
    await payBitcoin(run.deps, payeeAddress, 600_000n);
    const tx = broadcastTx(run.broadcast);
    expect(tx.ins).toHaveLength(2);
    const values = [500_000n, 254_051n];
    tx.ins.forEach((input, index) => {
      const [der, key] = input.witness as [Uint8Array, Uint8Array];
      expect(key).toEqual(PUBKEY);
      expect(der.at(-1)).toBe(1);
      const sighash = tx.hashForWitnessV0(index, scriptCode, values[index] ?? 0n, 1);
      expect(
        secp256k1.verify(der.slice(0, -1), sighash, PUBKEY, { prehash: false, format: "der" }),
      ).toBe(true);
    });
  });

  it("stays within the vsize the contract budgets for the fee cap", async () => {
    await payBitcoin(run.deps, payeeAddress, 600_000n);
    const signed = broadcastTx(run.broadcast);
    expect(BigInt(signed.virtualSize())).toBeLessThanOrEqual(contractVsize(run.proposal().tx));
  });

  it("converts a high s, which nodes won't relay, to low s", async () => {
    run = deps(honest(true));
    await payBitcoin(run.deps, payeeAddress, 20_000n);
    const [der] = broadcastTx(run.broadcast).ins[0]?.witness as [Uint8Array];
    const sighash = broadcastTx(run.broadcast).hashForWitnessV0(0, scriptCode, 500_000n, 1);
    expect(
      secp256k1.verify(der.slice(0, -1), sighash, PUBKEY, { prehash: false, format: "der" }),
    ).toBe(true);
  });

  it("never broadcasts a signature from the wrong key", async () => {
    const other = new Uint8Array(32).fill(9);
    run = deps((tx, values) => {
      const sighash = tx.hashForWitnessV0(0, scriptCode, values[0] ?? 0n, 1);
      const compact = secp256k1.sign(sighash, other, { prehash: false, format: "compact" });
      return {
        Signed: {
          id: "0",
          signatures: [
            {
              big_r: { affine_point: `02${hex.encode(compact.slice(0, 32))}` },
              s: { scalar: hex.encode(compact.slice(32)) },
              recovery_id: 0,
            },
          ],
        },
      };
    });
    await expect(payBitcoin(run.deps, payeeAddress, 20_000n)).rejects.toThrow("doesn't verify");
    expect(run.broadcast).not.toHaveBeenCalled();
  });

  it("never broadcasts a signature over a different amount", async () => {
    run = deps((tx, values) => ({
      Signed: { id: "0", signatures: [mpcSign(tx, 0, (values[0] ?? 0n) + 1n)] },
    }));
    await expect(payBitcoin(run.deps, payeeAddress, 20_000n)).rejects.toThrow("doesn't verify");
    expect(run.broadcast).not.toHaveBeenCalled();
  });

  it("never broadcasts when a signature is missing", async () => {
    run = deps(() => ({ Signed: { id: "0", signatures: [] } }));
    await expect(payBitcoin(run.deps, payeeAddress, 600_000n)).rejects.toThrow("signatures");
    expect(run.broadcast).not.toHaveBeenCalled();
  });

  it("reports a rejection without broadcasting", async () => {
    run = deps(() => ({ Rejected: "OutputNotWhitelisted" }));
    const result = await payBitcoin(run.deps, payeeAddress, 20_000n);
    expect(result).toEqual({
      status: "not_signed",
      outcome: { Rejected: "OutputNotWhitelisted" },
      nearTx: "near-tx",
    });
    expect(run.broadcast).not.toHaveBeenCalled();
  });

  it("refuses a spend the coins can't fund", async () => {
    await expect(payBitcoin(run.deps, payeeAddress, 759_051n)).rejects.toThrow("can't fund");
  });
});

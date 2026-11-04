import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import {
  bytesToHex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import type { SpendOutcome, VaultClient } from "../vault.js";
import { evmSignature, payEth, type EvmChain, type EvmSignature } from "./pay.js";

const SECRET = new Uint8Array(32).fill(7);
const point = secp256k1.getPublicKey(SECRET, false);
const VAULT = publicKeyToAddress(bytesToHex(point));
const PAYEE: Address = `0x${"aa".repeat(20)}`;
const ORDER = secp256k1.Point.Fn.ORDER;

function mpcSign(hash: Hex, secret = SECRET, highS = false): EvmSignature {
  const recovered = secp256k1.sign(hex.decode(hash.slice(2)), secret, {
    prehash: false,
    format: "recovered",
  });
  const [recovery, r, s] = [recovered[0] ?? 0, recovered.slice(1, 33), recovered.slice(33)];
  const flipped = (ORDER - BigInt(`0x${hex.encode(s)}`)).toString(16).padStart(64, "0");
  return {
    big_r: { affine_point: `02${hex.encode(r)}` },
    s: { scalar: highS ? flipped : hex.encode(s) },
    recovery_id: highS ? 1 - recovery : recovery,
  };
}

function setup(sign: (hash: Hex) => SpendOutcome) {
  const broadcast = vi.fn<EvmChain["broadcast"]>(async () => "0xabc");
  const proposed: Uint8Array[] = [];
  const vault: VaultClient = {
    btcPubkey: async () => new Uint8Array(),
    btcLimits: async () => ({ maxInputs: 0, maxFeeRate: 0n }),
    evmAddress: async () => VAULT,
    proposeBitcoin: async () => {
      throw new Error("not an EVM proposal");
    },
    proposeEvm: async (tx) => {
      proposed.push(tx);
      return { outcome: sign(keccak256(tx)), nearTx: "near-tx" };
    },
  };
  const chain: EvmChain = {
    chainId: 84532,
    pendingNonce: async () => 4,
    fees: async () => ({ maxFeePerGas: 6_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    broadcast,
  };
  return { deps: { vault, chain }, broadcast, proposed };
}

const signedBy =
  (secret = SECRET, highS = false) =>
  (hash: Hex): SpendOutcome => ({
    Signed: { id: "0", signatures: [mpcSign(hash, secret, highS)] },
  });

describe("payEth", () => {
  it("proposes the contract's accepted shape: type 2, plain transfer, empty access list", async () => {
    const run = setup(signedBy());
    await payEth(run.deps, PAYEE, 1_000n);
    const tx = parseTransaction(bytesToHex(run.proposed[0] as Uint8Array));
    expect(tx).toMatchObject({
      type: "eip1559",
      chainId: 84532,
      nonce: 4,
      gas: 21_000n,
      to: PAYEE,
      value: 1_000n,
    });
    expect(tx.data).toBeUndefined();
    expect(tx.r).toBeUndefined();
  });

  it("broadcasts a transaction that recovers to the vault", async () => {
    const run = setup(signedBy());
    const result = await payEth(run.deps, PAYEE, 1_000n);
    expect(result).toEqual({ status: "broadcast", id: "0", nearTx: "near-tx", hash: "0xabc" });
    const serialized = run.broadcast.mock.calls[0]?.[0] as Hex;
    const recovered = await recoverTransactionAddress({
      serializedTransaction: serialized as `0x02${string}`,
    });
    expect(recovered).toBe(VAULT);
  });

  it("flips a high s and its recovery bit", async () => {
    const run = setup(signedBy(SECRET, true));
    await payEth(run.deps, PAYEE, 1_000n);
    const serialized = run.broadcast.mock.calls[0]?.[0] as `0x02${string}`;
    const tx = parseTransaction(serialized);
    expect(BigInt(tx.s as Hex) <= ORDER / 2n).toBe(true);
    await expect(recoverTransactionAddress({ serializedTransaction: serialized })).resolves.toBe(
      VAULT,
    );
  });

  it("never broadcasts a signature from the wrong key", async () => {
    const run = setup(signedBy(new Uint8Array(32).fill(9)));
    await expect(payEth(run.deps, PAYEE, 1_000n)).rejects.toThrow("not the vault's");
    expect(run.broadcast).not.toHaveBeenCalled();
  });

  it("never broadcasts a signature over a different hash", async () => {
    const run = setup(() => ({
      Signed: { id: "0", signatures: [mpcSign(`0x${"11".repeat(32)}`)] },
    }));
    await expect(payEth(run.deps, PAYEE, 1_000n)).rejects.toThrow("not the vault's");
    expect(run.broadcast).not.toHaveBeenCalled();
  });

  it("never broadcasts when the signature count is wrong", async () => {
    const run = setup(() => ({ Signed: { id: "0", signatures: [] } }));
    await expect(payEth(run.deps, PAYEE, 1_000n)).rejects.toThrow("expected 1 signature");
    expect(run.broadcast).not.toHaveBeenCalled();
  });

  it("reports a rejection without broadcasting", async () => {
    const run = setup(() => ({ Rejected: "OutputNotWhitelisted" }));
    const result = await payEth(run.deps, PAYEE, 1_000n);
    expect(result).toEqual({
      status: "not_signed",
      outcome: { Rejected: "OutputNotWhitelisted" },
      nearTx: "near-tx",
    });
    expect(run.broadcast).not.toHaveBeenCalled();
  });
});

describe("evmSignature", () => {
  it("refuses a recovery id that isn't 0 or 1", async () => {
    const hash = keccak256("0x01");
    const signature = { ...mpcSign(hash), recovery_id: 2 };
    await expect(evmSignature(signature, hash, VAULT)).rejects.toThrow("recovery id");
  });
});

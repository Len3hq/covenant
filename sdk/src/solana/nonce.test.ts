import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { NONCE_ACCOUNT_LEN, RECENT_BLOCKHASHES_SYSVAR, RENT_SYSVAR, SYSTEM_PROGRAM } from "./message.js";
import {
  createNonceAccount,
  NeedsFunding,
  nonceAccountTransaction,
  NONCE_SETUP_FEES,
  solanaKeypair,
  solanaKeypairFromSecret,
  solanaSecret,
  type NonceSetupRpc,
} from "./nonce.js";

const seed = (byte: number) => new Uint8Array(32).fill(byte);
const funder = solanaKeypair(seed(1));
const nonce = solanaKeypair(seed(2));
const vault = solanaKeypair(seed(3)).publicKey;
const blockhash = new Uint8Array(32).fill(9);
const RENT = 1_447_680n;

const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
const u64 = (value: bigint) => Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));

function rpc(balance: bigint, sent: Uint8Array[] = []): NonceSetupRpc {
  return {
    rentExempt: async (space) => (space === NONCE_ACCOUNT_LEN ? RENT : 0n),
    balance: async () => balance,
    latestBlockhash: async () => blockhash,
    sendAndConfirm: async (transaction) => {
      sent.push(transaction);
      return "sig";
    },
  };
}

describe("nonce account setup", () => {
  it("builds a transaction the funder and the new account both sign", () => {
    const tx = nonceAccountTransaction(funder, nonce, vault, RENT, blockhash);
    expect(tx[0]).toBe(2);
    const signatures = [tx.slice(1, 65), tx.slice(65, 129)];
    const message = tx.slice(129);
    expect(ed25519.verify(signatures[0] as Uint8Array, message, funder.publicKey)).toBe(true);
    expect(ed25519.verify(signatures[1] as Uint8Array, message, nonce.publicKey)).toBe(true);

    // Two writable signers, no read-only signers, three read-only others.
    expect([...message.slice(0, 4)]).toEqual([2, 0, 3, 5]);
    const keys = Array.from({ length: 5 }, (_, i) => [...message.slice(4 + 32 * i, 36 + 32 * i)]);
    expect(keys).toEqual([funder.publicKey, nonce.publicKey, SYSTEM_PROGRAM, RECENT_BLOCKHASHES_SYSVAR, RENT_SYSVAR].map((k) => [...k]));
    expect([...message.slice(164, 196)]).toEqual([...blockhash]);

    const instructions = [...message.slice(196)];
    const create = [2, 2, 0, 1, 52, ...u32(0), ...u64(RENT), ...u64(BigInt(NONCE_ACCOUNT_LEN)), ...SYSTEM_PROGRAM];
    const initialize = [2, 3, 1, 3, 4, 36, ...u32(6), ...vault];
    expect(instructions).toEqual([2, ...create, ...initialize]);
  });

  it("sends it when the funder holds the rent and the fee", async () => {
    const sent: Uint8Array[] = [];
    const created = await createNonceAccount(rpc(RENT + NONCE_SETUP_FEES, sent), funder, vault, nonce);
    expect(created).toEqual({ account: nonce.publicKey, signature: "sig" });
    expect(sent).toEqual([nonceAccountTransaction(funder, nonce, vault, RENT, blockhash)]);
  });

  it("asks for funding, and sends nothing, when the funder is short", async () => {
    const sent: Uint8Array[] = [];
    const short = createNonceAccount(rpc(RENT, sent), funder, vault, nonce);
    await expect(short).rejects.toBeInstanceOf(NeedsFunding);
    await expect(short).rejects.toMatchObject({ has: RENT, needed: RENT + NONCE_SETUP_FEES });
    expect(sent).toEqual([]);
  });

  it("reads back the 64-byte secret it writes, and refuses a mismatched one", () => {
    expect(solanaKeypairFromSecret(solanaSecret(funder))).toEqual(funder);
    const wrong = solanaSecret(funder);
    wrong[40] ^= 1;
    expect(() => solanaKeypairFromSecret(wrong)).toThrow("doesn't match");
  });
});

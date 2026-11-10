import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, hex } from "@scure/base";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceNonce,
  associatedTokenAccount,
  compileMessage,
  setComputeUnitLimit,
  setComputeUnitPrice,
  transfer,
  transferChecked,
} from "./message.js";
import { prepareSolana, signSolana, solanaKey, type SolanaDeps } from "./pay.js";

interface Vector {
  name: string;
  message: string;
  vault: string;
  nonce_account: string;
  nonce: string;
  payee_wallet: string;
  payee: string;
  vault_token_account: string;
  mint: string | null;
  amount: string;
}

const VECTORS = (
  JSON.parse(readFileSync(new URL("../../../tests/vectors/solana_message.json", import.meta.url), "utf8")) as {
    vectors: Vector[];
  }
).vectors;
const [SOL_VECTOR, USDC_VECTOR] = VECTORS as [Vector, Vector];
const USDC = base58.decode("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const SECRET = new Uint8Array(32).fill(9);
const VAULT = ed25519.getPublicKey(SECRET);
const NONCE_VALUE = new Uint8Array(32).fill(0x55);

function deps(overrides: Partial<SolanaDeps> = {}, tokenAccounts: Uint8Array[] = []): SolanaDeps {
  return {
    rpc: {
      nonce: async () => ({ authority: VAULT, nonce: NONCE_VALUE }),
      isTokenAccount: async (address) => tokenAccounts.some((known) => hex.encode(known) === hex.encode(address)),
    },
    vaultKey: async () => VAULT,
    nonceAccounts: [base58.encode(new Uint8Array(32).fill(2)), base58.encode(new Uint8Array(32).fill(3))],
    usdcMint: USDC,
    ...overrides,
  };
}

function readShortVec(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; ; i++) {
    const byte = bytes[at + i] ?? 0;
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return [value, at + i + 1];
  }
}

/**
 * What a legacy message means, independent of key order: each key's privileges, the blockhash, and
 * each instruction by key. web3.js sorts keys by their base58 text, and the runtime accepts any order.
 */
function meaning(message: Uint8Array) {
  const [signers = 0, readonlySigned = 0, readonlyUnsigned = 0] = message;
  let [count, at] = readShortVec(message, 3);
  const keys: string[] = [];
  for (let i = 0; i < count; i++, at += 32) keys.push(base58.encode(message.slice(at, at + 32)));
  const privilege = (i: number) => ({
    signer: i < signers,
    writable: i < signers ? i < signers - readonlySigned : i < keys.length - readonlyUnsigned,
  });
  const blockhash = hex.encode(message.slice(at, at + 32));
  at += 32;
  [count, at] = readShortVec(message, at);
  const instructions = [];
  for (let i = 0; i < count; i++) {
    const program = keys[message[at] ?? 0];
    let accounts: number;
    [accounts, at] = readShortVec(message, at + 1);
    const accountKeys = [...message.slice(at, at + accounts)].map((index) => keys[index]);
    at += accounts;
    let length: number;
    [length, at] = readShortVec(message, at);
    instructions.push({ program, accounts: accountKeys, data: hex.encode(message.slice(at, at + length)) });
    at += length;
  }
  expect(at).toBe(message.length);
  return {
    feePayer: keys[0],
    privileges: Object.fromEntries(keys.map((key, i) => [key, privilege(i)])),
    blockhash,
    instructions,
  };
}

describe("compileMessage", () => {
  it("means what @solana/web3.js does for a SOL transfer", () => {
    const vault = hex.decode(SOL_VECTOR.vault);
    const message = compileMessage(vault, base58.decode(SOL_VECTOR.nonce), [
      advanceNonce(base58.decode(SOL_VECTOR.nonce_account), vault),
      transfer(vault, base58.decode(SOL_VECTOR.payee_wallet), BigInt(SOL_VECTOR.amount)),
    ]);
    expect(meaning(message)).toEqual(meaning(hex.decode(SOL_VECTOR.message)));
  });

  it("means what @solana/web3.js does for a USDC transfer with a priority fee", () => {
    const vault = hex.decode(USDC_VECTOR.vault);
    const mint = hex.decode(USDC_VECTOR.mint ?? "");
    const message = compileMessage(vault, base58.decode(USDC_VECTOR.nonce), [
      advanceNonce(base58.decode(USDC_VECTOR.nonce_account), vault),
      setComputeUnitLimit(20_000),
      setComputeUnitPrice(1_000_000n),
      transferChecked(
        associatedTokenAccount(vault, mint),
        mint,
        associatedTokenAccount(base58.decode(USDC_VECTOR.payee_wallet), mint),
        vault,
        BigInt(USDC_VECTOR.amount),
        6,
      ),
    ]);
    expect(meaning(message)).toEqual(meaning(hex.decode(USDC_VECTOR.message)));
  });

  it("derives associated token accounts as web3.js does", () => {
    const vault = hex.decode(USDC_VECTOR.vault);
    expect(base58.encode(associatedTokenAccount(vault, USDC))).toBe(USDC_VECTOR.vault_token_account);
    expect(hex.encode(associatedTokenAccount(base58.decode(USDC_VECTOR.payee_wallet), USDC))).toBe(
      USDC_VECTOR.payee,
    );
  });

  // Read from devnet on 10 Nov: a USDC account and the wallet that owns it.
  it("derives a real devnet associated token account", () => {
    const wallet = base58.decode("2SkT6DZgbfWjuLwzMR5UGZUs7pUdadyNrJv8TQ1QyKz6");
    expect(base58.encode(associatedTokenAccount(wallet, USDC))).toBe("2n4w2JtCwgJEkF4kLx1JnE8UdTYCeuN8pyzH6t8qPTiA");
  });
});

describe("prepareSolana", () => {
  const payee = new Uint8Array(32).fill(0xaa);

  it("advances the first free nonce account, then pays", async () => {
    const free = deps();
    const held = base58.encode(new Uint8Array(32).fill(2));
    const prepared = await prepareSolana(
      { ...free, heldNonces: () => new Set([held]) },
      "SOL",
      base58.encode(payee),
      7n,
    );
    expect(prepared.nonceAccount).toBe(base58.encode(new Uint8Array(32).fill(3)));
    const expected = compileMessage(VAULT, NONCE_VALUE, [
      advanceNonce(new Uint8Array(32).fill(3), VAULT),
      transfer(VAULT, payee, 7n),
    ]);
    expect(prepared.unsignedHex).toBe(hex.encode(expected));
  });

  it("pays a wallet's USDC into its associated token account", async () => {
    const prepared = await prepareSolana(deps(), "USDC-SOL", base58.encode(payee), 1_000_000n);
    expect(prepared.unsignedHex).toContain(hex.encode(associatedTokenAccount(payee, USDC)));
    expect(prepared.unsignedHex).toContain(hex.encode(associatedTokenAccount(VAULT, USDC)));
  });

  it("pays a listed token account directly", async () => {
    const prepared = await prepareSolana(deps({}, [payee]), "USDC-SOL", base58.encode(payee), 1n);
    expect(prepared.unsignedHex).toContain(hex.encode(payee));
    expect(prepared.unsignedHex).not.toContain(hex.encode(associatedTokenAccount(payee, USDC)));
  });

  it("refuses a nonce account the vault doesn't control", async () => {
    const stranger = deps({
      rpc: { ...deps().rpc, nonce: async () => ({ authority: payee, nonce: NONCE_VALUE }) },
    });
    await expect(prepareSolana(stranger, "SOL", base58.encode(payee), 1n)).rejects.toThrow(/not the vault/);
  });

  it("says when every nonce account is held, or none is set", async () => {
    const all = deps();
    const held = () => new Set(all.nonceAccounts);
    await expect(prepareSolana({ ...all, heldNonces: held }, "SOL", base58.encode(payee), 1n)).rejects.toThrow(
      /held by an unfinished payment/,
    );
    await expect(prepareSolana(deps({ nonceAccounts: [] }), "SOL", base58.encode(payee), 1n)).rejects.toThrow(
      /make sol-nonce/,
    );
  });

  it("refuses something that isn't a Solana address", () => {
    expect(() => solanaKey("0xabc")).toThrow(/isn't a Solana address/);
    expect(() => solanaKey(base58.encode(new Uint8Array(20)))).toThrow(/isn't a Solana address/);
  });
});

describe("signSolana", () => {
  const message = compileMessage(VAULT, NONCE_VALUE, [
    advanceNonce(new Uint8Array(32).fill(2), VAULT),
    transfer(VAULT, new Uint8Array(32).fill(0xaa), 5n),
  ]);
  const prepared = { chain: "Solana" as const, unsignedHex: hex.encode(message), nonceAccount: "x" };
  const signature = ed25519.sign(message, SECRET);

  it("puts the checked signature in front of the message", () => {
    const { signedHex, chainTx } = signSolana(
      prepared,
      [{ scheme: "Ed25519", signature: [...signature] }],
      VAULT,
    );
    expect(signedHex).toBe(hex.encode(Uint8Array.from([1, ...signature, ...message])));
    expect(chainTx).toBe(base58.encode(signature));
  });

  it("refuses a signature that doesn't verify, or isn't Ed25519", () => {
    const forged = [...signature];
    forged[0] = (forged[0] ?? 0) ^ 1;
    expect(() => signSolana(prepared, [{ scheme: "Ed25519", signature: forged }], VAULT)).toThrow(/doesn't verify/);
    expect(() =>
      signSolana(prepared, [{ big_r: { affine_point: "02" }, s: { scalar: "00" }, recovery_id: 0 }], VAULT),
    ).toThrow(/expected 1 Ed25519 signature/);
  });
});

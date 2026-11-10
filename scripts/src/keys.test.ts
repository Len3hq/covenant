import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  compressPubkey,
  evmAddress,
  type MpcEcdsaSignature,
  p2wpkhAddress,
  parseNearEd25519,
  parseNearSecp256k1,
  solanaAddress,
  verifyMpcEd25519,
  verifyMpcSignature,
} from "./keys.ts";

// A real Ed25519 response from v1.signer-prod.testnet, requested by len3hq.testnet on path
// sol-spike-1. Transaction BeX39ENFf3Ud1E95eoBqZAj1fo3U5F7TCpLD7D1wDms2.
const ED_KEY = parseNearEd25519("ed25519:9ojZDfccWSPQ9xjaFBhHZqTgeP3xiErzRo8pSpfh7rog");
const ED_MESSAGE = new TextEncoder().encode("covenant solana spike ".repeat(4)).slice(0, 80);
const ED_SIGNATURE = [
  97, 251, 183, 179, 192, 76, 246, 136, 162, 16, 72, 121, 244, 115, 181, 19, 27, 184, 113, 154, 193, 37, 226, 149,
  57, 95, 40, 113, 74, 164, 146, 225, 209, 182, 8, 45, 63, 199, 220, 120, 165, 136, 222, 244, 151, 216, 126, 242,
  66, 132, 195, 38, 207, 254, 231, 28, 238, 197, 202, 34, 193, 236, 87, 1,
];

describe("verifyMpcEd25519", () => {
  it("accepts a real MPC signature over the whole message", () => {
    expect(verifyMpcEd25519(ED_SIGNATURE, ED_MESSAGE, ED_KEY)).toBe(true);
  });

  it("rejects it for another message", () => {
    const tampered = Uint8Array.from(ED_MESSAGE, (byte, index) => (index === 0 ? byte ^ 1 : byte));
    expect(verifyMpcEd25519(ED_SIGNATURE, tampered, ED_KEY)).toBe(false);
  });

  it("writes the key as a Solana address", () => {
    expect(solanaAddress(ED_KEY)).toBe("9ojZDfccWSPQ9xjaFBhHZqTgeP3xiErzRo8pSpfh7rog");
    expect(() => parseNearEd25519("secp256k1:abc")).toThrow();
  });
});

// secp256k1 generator: the key for private key 1, which has well-known addresses.
const GENERATOR = hex.decode(
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
    "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
);

// A real response from v1.signer-prod.testnet, requested by spike.len3hq.testnet on path spike-1.
// Transaction CdLQi7E23L8E2rXZ78F7ykKvL3fDZpphNBv6jcEPYCoN.
const LIVE_PAYLOAD = hex.decode("89a73179c344b8d52a3205f42c1f7af2ffb18a91deb285976f3b55c040305a04");
const LIVE_KEY = compressPubkey(
  parseNearSecp256k1(
    "secp256k1:2ynXcdYJAPh5Nyz9Y33js8QveAbveP2e2HQSzkBK85d8ES5wPWFBgmxFghVqLpqGWDwnwAmZLCRGiTyADuciUiQo",
  ),
);
const LIVE_SIGNATURE: MpcEcdsaSignature = {
  scheme: "Secp256k1",
  big_r: { affine_point: "0265c90fd8479fe510e68c39fb23e42bf30e1869e6affb2249c09820a08bb664ec" },
  s: { scalar: "08f7ed44a950030d0cbb3b5066a08049ded45620080af5c455617fbaec6a3878" },
  recovery_id: 1,
};

describe("addresses", () => {
  it("compresses by the parity of y", () => {
    expect(hex.encode(compressPubkey(GENERATOR))).toBe(
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
  });

  it("matches the BIP173 testnet P2WPKH vector", () => {
    expect(p2wpkhAddress(compressPubkey(GENERATOR))).toBe(
      "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    );
  });

  it("matches the EVM address of private key 1", () => {
    expect(evmAddress(GENERATOR)).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });

  it("refuses a key of another type", () => {
    expect(() => parseNearSecp256k1("ed25519:abc")).toThrow();
  });
});

describe("verifyMpcSignature", () => {
  it("accepts a real MPC signature for the derived key", () => {
    expect(verifyMpcSignature(LIVE_SIGNATURE, LIVE_PAYLOAD, LIVE_KEY)).toBe(true);
  });

  it("rejects it for another key", () => {
    expect(verifyMpcSignature(LIVE_SIGNATURE, LIVE_PAYLOAD, compressPubkey(GENERATOR))).toBe(false);
  });

  it("rejects it for another payload", () => {
    const tampered = LIVE_PAYLOAD.slice();
    tampered[0] = 0;
    expect(verifyMpcSignature(LIVE_SIGNATURE, tampered, LIVE_KEY)).toBe(false);
  });
});

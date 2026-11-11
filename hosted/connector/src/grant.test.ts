import { KeyPair, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkGrant, verifyGrant, type Terms } from "./grant.js";
import { fakeChain, walletGrant } from "./testkit.js";

const secret = KeyPair.fromRandom("ed25519").toString();
const ownerKey = KeyPair.fromString(secret as KeyPairString).getPublicKey().toString();
const terms: Terms = {
  owner: "frankieme.testnet",
  vault: "frank.vaults-v3.len3hq.testnet",
  agent: "hosted.frankieme.testnet",
  expires: 1_900_000_000,
};
const now = 1_800_000_000;

describe("grants", () => {
  it("verifies a grant a NEAR wallet signed", async () => {
    expect(verifyGrant(await walletGrant(terms, secret))).toEqual(terms);
  });

  it("verifies the grant the enclave's tests also check", () => {
    const vector = JSON.parse(readFileSync(new URL("../../../tests/vectors/grant.json", import.meta.url), "utf8"));
    expect(verifyGrant(vector.grant)).toEqual(vector.terms);
  });

  it("checks the key, the vault's roles and the expiry against the chain", async () => {
    const grant = await walletGrant(terms, secret);
    await expect(checkGrant(grant, fakeChain(terms, ownerKey), now)).resolves.toEqual(terms);
    await expect(checkGrant(grant, fakeChain(terms, "ed25519:other"), now)).rejects.toThrow("isn't a full-access key");
    await expect(checkGrant(grant, fakeChain({ ...terms, agent: "x.testnet" }, ownerKey), now)).rejects.toThrow("doesn't name");
    await expect(checkGrant(grant, fakeChain(terms, ownerKey), terms.expires)).rejects.toThrow("expired");
  });

  it("refuses a changed or malformed grant", async () => {
    const grant = await walletGrant(terms, secret);
    expect(() => verifyGrant({ ...grant, message: grant.message.replace("frank.", "evil.") })).toThrow("doesn't verify");
    expect(() => verifyGrant({ ...grant, message: `${grant.message} extra=1` })).toThrow("a grant reads");
  });
});

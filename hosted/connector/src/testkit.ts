import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { GRANT_RECIPIENT, grantMessage, type ChainView, type Grant, type Terms } from "./grant.js";

/** A grant signed the way a NEAR wallet's `signMessage` signs, through near-api-js. */
export async function walletGrant(terms: Terms, secret: string): Promise<Grant> {
  const message = grantMessage(terms);
  const nonce = new Uint8Array(32).fill(3);
  const signer = new KeyPairSigner(KeyPair.fromString(secret as KeyPairString));
  const signed = await signer.signNep413Message(terms.owner, { message, recipient: GRANT_RECIPIENT, nonce });
  return {
    message,
    nonce: Buffer.from(nonce).toString("base64"),
    public_key: signed.publicKey.toString(),
    signature: Buffer.from(signed.signature).toString("base64"),
  };
}

/** A chain where `owner` holds `ownerKey` with full access and owns `vault`, run by `agent`. */
export function fakeChain(terms: Terms, ownerKey: string): ChainView {
  return {
    isFullAccess: async (account, key) => account === terms.owner && key === ownerKey,
    roles: async (vault) => {
      if (vault !== terms.vault) throw new Error(`${vault} isn't a Covenant vault`);
      return { owner: terms.owner, agent: terms.agent };
    },
  };
}

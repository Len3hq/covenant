import {
  compressPubkey,
  evmAddress,
  p2wpkhAddress,
  parseNearEd25519,
  parseNearSecp256k1,
  solanaAddress,
} from "./keys.ts";
import { requireEnv, viewCall } from "./near.ts";

/** The secp256k1 signing domain on `v1.signer-prod.testnet`. */
export const ECDSA_DOMAIN_ID = 0;
/** The Ed25519 signing domain, for Solana. */
export const EDDSA_DOMAIN_ID = 1;
/** Every vault stores this path for Solana; it isn't configurable. */
export const SOL_PATH = "sol-vault-1";

async function derivedPoint(rpcUrl: string, signer: string, path: string, predecessor: string) {
  const key = await viewCall<string>(rpcUrl, signer, "derived_public_key", {
    path,
    predecessor,
    domain_id: ECDSA_DOMAIN_ID,
  });
  return parseNearSecp256k1(key);
}

export async function deriveVaultKeys() {
  const rpcUrl = requireEnv("NEAR_RPC_URL");
  const signer = requireEnv("MPC_SIGNER_ACCOUNT_ID");
  const vault = requireEnv("VAULT_ACCOUNT_ID");
  const btcPubkey = compressPubkey(
    await derivedPoint(rpcUrl, signer, requireEnv("BTC_PATH"), vault),
  );
  const evmPoint = await derivedPoint(rpcUrl, signer, requireEnv("EVM_PATH"), vault);
  const solPubkey = parseNearEd25519(
    await viewCall<string>(rpcUrl, signer, "derived_public_key", {
      path: SOL_PATH,
      predecessor: vault,
      domain_id: EDDSA_DOMAIN_ID,
    }),
  );
  return {
    vault,
    btcPubkey,
    btcAddress: p2wpkhAddress(btcPubkey),
    evmAddress: evmAddress(evmPoint),
    solPubkey,
    solAddress: solanaAddress(solPubkey),
  };
}

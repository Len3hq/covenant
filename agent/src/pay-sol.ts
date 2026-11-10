// Pays from the vault on Solana devnet:
// `node --env-file=.env agent/dist/pay-sol.js <address> <lamports or USDC base units> [USDC]`.
import { prepareSolana, signSolana, SolanaRpc } from "@covenant/sdk";
import { base58 } from "@scure/base";
import { connectVaultFromEnv } from "./env.js";

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const [to, amount, token] = process.argv.slice(2);
if (!to || !amount) throw new Error("usage: pay-sol <address> <amount> [USDC]");
const nonceAccounts = (process.env.SOL_NONCE_ACCOUNTS ?? "").split(",").map((a) => a.trim()).filter(Boolean);

const vault = connectVaultFromEnv();
const rpc = new SolanaRpc(process.env.SOL_RPC_URL || "https://api.devnet.solana.com");
const prepared = await prepareSolana(
  { rpc, vaultKey: () => vault.solPubkey(), nonceAccounts, usdcMint: base58.decode(DEVNET_USDC) },
  token === "USDC" ? "USDC-SOL" : "SOL",
  to,
  BigInt(amount),
);
const { outcome, nearTx } = await vault.proposeSolana(Buffer.from(prepared.unsignedHex, "hex"));
console.log(JSON.stringify({ nearTx, outcome }));
if ("Signed" in outcome) {
  const { signedHex } = signSolana(prepared, outcome.Signed.signatures, await vault.solPubkey());
  const signature = await rpc.sendAndConfirm(Buffer.from(signedHex, "hex"));
  console.log(JSON.stringify({ signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` }));
}

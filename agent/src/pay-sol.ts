// Pays SOL, or USDC on Solana, from the vault on Solana devnet, recording the payment so a held one
// can be executed later. Needs SOL_NONCE_ACCOUNTS:
// `node --env-file=.env agent/dist/pay-sol.js <address or payee> <lamports or USDC base units> [USDC] [reference]`.
import { payFromCli } from "./env.js";

const [to, amount, ...rest] = process.argv.slice(2);
const usdc = rest[0] === "USDC";
const reference = usdc ? rest[1] : rest[0];
await payFromCli(
  usdc ? "USDC-SOL" : "SOL",
  "pay-sol <address or payee> <lamports or USDC base units> [USDC] [reference]",
  [to ?? "", amount ?? "", ...(reference ? [reference] : [])],
);

// Pays USDC from the vault on Base Sepolia, recording the payment so a held one can be executed later:
// `node --env-file=.env agent/dist/pay-usdc.js <address or payee> <base units> [reference]`.
import { payFromCli } from "./env.js";

await payFromCli("USDC", "pay-usdc <address or payee> <base units> [reference]", process.argv.slice(2));

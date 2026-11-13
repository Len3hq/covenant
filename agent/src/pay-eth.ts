// Pays ETH from the vault on Base Sepolia, recording the payment so a held one can be executed later:
// `node --env-file=.env agent/dist/pay-eth.js <address or payee> <wei> [reference]`.
import { payFromCli } from "./env.js";

await payFromCli("ETH", "pay-eth <address or payee> <wei> [reference]", process.argv.slice(2));

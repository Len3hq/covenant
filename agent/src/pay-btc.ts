// Pays from the vault on Bitcoin testnet4, recording the payment so a held one can be executed later:
// `node --env-file=.env agent/dist/pay-btc.js <address or payee> <sats> [reference]`.
import { payFromCli } from "./env.js";

await payFromCli("BTC", "pay-btc <address or payee> <sats> [reference]", process.argv.slice(2));

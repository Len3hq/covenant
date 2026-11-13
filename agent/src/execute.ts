// Signs and broadcasts a held payment once its veto window has passed:
// `node --env-file=.env agent/dist/execute.js <spend id>`. Works for any payment recorded in
// SPENDS_FILE: the pay-* scripts, pay-swap and the MCP server all record theirs.
import { walletFromEnv } from "./env.js";

const [id] = process.argv.slice(2);
if (!id) throw new Error("usage: execute <spend id>");
console.log(JSON.stringify(await walletFromEnv().execute(id), null, 2));

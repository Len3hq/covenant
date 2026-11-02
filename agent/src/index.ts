import { parseArgs } from "./cli.js";

const { scenario, replay } = parseArgs(process.argv.slice(2));
console.error(JSON.stringify({ scenario, replay, outcome: "not_implemented" }));
process.exit(1);

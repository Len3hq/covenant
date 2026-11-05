import { randomUUID } from "node:crypto";
import { parseArgs } from "./cli.js";
import { createLlm } from "./llm/index.js";
import { jsonLog } from "./log.js";
import { runAgent } from "./loop.js";
import { createRuntime, scenarioText } from "./runtime.js";

const { scenario, replay, run } = parseArgs(process.argv.slice(2));
// Replay and the attack and queue scenarios arrive at M8. Until then they fail, not pretend.
if (replay || scenario !== "pay") {
  console.error(JSON.stringify({ scenario, replay, outcome: "not_implemented" }));
  process.exit(1);
}

const runId = run ?? randomUUID();
const { tools, spends } = createRuntime(runId);

jsonLog("run_started", { scenario, runId, model: process.env.LLM_MODEL });
const llm = createLlm({
  model: process.env.LLM_MODEL,
  apiKey: process.env.LLM_API_KEY,
  baseUrl: process.env.LLM_BASE_URL,
});
const answer = await runAgent({
  llm,
  system: scenarioText("system.txt"),
  user: scenarioText(`${scenario}.txt`),
  tools,
  log: jsonLog,
});

console.log(JSON.stringify({ scenario, runId, spends, answer }, null, 2));
const paid = spends.filter(({ report }) => report.status === "broadcast");
// The scenario's check: two signed payments, each with an explorer link.
process.exit(paid.length === 2 && paid.every(({ report }) => report.links.chain) ? 0 : 1);

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { check } from "./checks.js";
import { parseArgs, scenarios } from "./cli.js";
import { liveWorld } from "./live.js";
import { createLlm } from "./llm/index.js";
import { jsonLog } from "@len3hq/covenant-sdk";
import { runAgent } from "./loop.js";
import { readReplay, replayLlm } from "./replay.js";
import { createRuntime, scenarioText, type Spend, type World } from "./runtime.js";
import { sandboxWorld } from "./sandbox.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url);
const args = parseArgs(process.argv.slice(2));
const attackers = (JSON.parse(readFileSync(new URL("attackers.json", SCENARIOS), "utf8")) as string[]).map(
  (address) => address.toLowerCase(),
);

function userPrompt(scenario: string): string {
  const prompt = scenarioText(`${scenario}.txt`);
  return scenario === "attack" ? `${prompt}\n\n${scenarioText("invoice-poisoned.txt")}` : prompt;
}

function describe(spend: Spend): string {
  const { report } = spend;
  const outcome =
    report.status === "broadcast"
      ? "signed"
      : report.status === "rejected"
        ? `refused: ${report.error}`
        : report.status === "queued"
          ? `queued for the veto window (spend ${report.id})`
          : `${report.status}${report.error ? `: ${report.error}` : ""}`;
  const where = Object.values(report.links).join("  ");
  return `  ${spend.asset} to ${spend.to}: ${outcome}${where ? `\n      ${where}` : ""}`;
}

async function runScenario(world: World, scenario: string, runId: string): Promise<boolean> {
  console.log(`\n== ${scenario} ==`);
  const { tools, spends } = createRuntime(world, `${runId}-${scenario}`);
  const replayUrl = new URL(`${scenario}.replay.json`, SCENARIOS);
  const recorded: { tool: string; input: unknown }[][] = [];
  const llm = args.llm
    ? createLlm({
        model: process.env.LLM_MODEL,
        apiKey: process.env.LLM_API_KEY,
        baseUrl: process.env.LLM_BASE_URL,
      })
    : replayLlm(readReplay(replayUrl));
  if (!args.llm) console.log(`  Replaying tool calls ${readReplay(replayUrl).source}.`);
  const answer = await runAgent({
    llm,
    system: scenarioText("system.txt"),
    user: userPrompt(scenario),
    tools,
    log: jsonLog,
    onTurn: (calls) => recorded.push(calls),
  });
  for (const spend of spends) console.log(describe(spend));

  if (scenario === "queue") {
    const queued = spends.find(({ report }) => report.status === "queued")?.report.id;
    if (queued && world.veto) {
      await world.veto(queued);
      const still = (await world.vault.queue()).some(({ id }) => id === queued);
      console.log(`  The owner vetoed spend ${queued}: ${still ? "still queued" : "removed, budget returned"}`);
      if (still) return false;
    } else if (queued) {
      console.log(`  Veto it from the dashboard, or with: make dao-veto ID=${queued}`);
    }
  }
  if (args.llm) console.log(`  The model said: ${answer.replaceAll("\n", "\n    ")}`);
  if (args.record) {
    const source = `recorded from ${process.env.LLM_MODEL} on ${world.name === "live" ? "testnet" : "the sandbox"}, ${new Date().toISOString().slice(0, 10)}`;
    writeFileSync(replayUrl, `${JSON.stringify({ source, turns: recorded }, null, 2)}\n`);
  }
  const verdict = check(scenario, spends, attackers, args.llm);
  console.log(`  ${verdict.passed ? "PASS" : "FAIL"}: ${verdict.summary}`);
  return verdict.passed;
}

const started = Date.now();
if (!args.live) {
  console.log(
    "Running the real Covenant contract on a local NEAR sandbox. Signatures come from a mock signer, " +
      "Bitcoin and Base are simulated, and nothing is broadcast. Live testnet proof is in EVIDENCE.md.",
  );
  if (!existsSync("target/near/covenant_vault/covenant_vault.wasm")) {
    console.error("The contract isn't built. Run `make wasm`, or `make demo`, which builds it first.");
    process.exit(1);
  }
}
const world = args.live ? liveWorld() : await sandboxWorld();
const runId = args.run ?? randomUUID();
const chosen = args.scenario === "all" ? [...scenarios] : [args.scenario];
let passed = true;
try {
  for (const scenario of chosen) passed = (await runScenario(world, scenario, runId)) && passed;
} finally {
  world.stop();
}
console.log(`\n${passed ? "All scenarios passed" : "A scenario failed"} in ${Math.round((Date.now() - started) / 1000)} s.`);
process.exit(passed ? 0 : 1);

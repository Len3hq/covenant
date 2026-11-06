import { readFileSync } from "node:fs";
import type { PayDeps } from "./bitcoin/pay.js";
import type { EvmChain } from "./evm/pay.js";
import { jsonLog } from "./log.js";
import { Payer, type Assemble, type Broadcasters, type links, type SpendReport } from "./payer.js";
import { SpendStore } from "./store.js";
import { createTools, type ChainReads } from "./tools.js";
import type { AgentVault } from "./vault.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url);
export const scenarioText = (name: string) => readFileSync(new URL(name, SCENARIOS), "utf8").trim();

export interface Spend {
  asset: string;
  to: string;
  report: SpendReport;
}

/** Where the agent runs: the live testnets, or a local sandbox with simulated chains. */
export interface World {
  name: "live" | "sandbox";
  vault: AgentVault;
  mempool: PayDeps["mempool"];
  chain: EvmChain;
  reads: ChainReads;
  broadcast: Broadcasters;
  usdc: `0x${string}`;
  spendsFile: string;
  assemble?: Assemble;
  links?: typeof links;
  /** Removes a queued spend as its owner, where the world holds that key. */
  veto?: (id: string) => Promise<void>;
  stop(): void;
}

/** The agent's tools for one run, and the spends they make. */
export function createRuntime(world: World, runId: string) {
  const spends: Spend[] = [];
  const payer = new Payer({
    vault: world.vault,
    store: new SpendStore(world.spendsFile),
    log: jsonLog,
    broadcast: world.broadcast,
    ...(world.assemble ? { assemble: world.assemble } : {}),
    ...(world.links ? { links: world.links } : {}),
  });
  const tools = createTools({
    vault: world.vault,
    payer,
    chain: world.chain,
    usdc: world.usdc,
    runId,
    bitcoin: { vault: world.vault, mempool: world.mempool },
    reads: world.reads,
    onSpend: (asset, to, report) => spends.push({ asset, to, report }),
  });
  return { tools, spends };
}

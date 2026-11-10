import { readFileSync } from "node:fs";
import type { PayDeps } from "@len3hq/covenant-sdk";
import type { EvmChain } from "@len3hq/covenant-sdk";
import { jsonLog } from "@len3hq/covenant-sdk";
import { Payer, type Assemble, type Broadcasters, type links, type SpendReport } from "@len3hq/covenant-sdk";
import { SpendStore } from "@len3hq/covenant-sdk";
import { createTools, type ChainReads } from "./tools.js";
import type { AgentVault, SolanaDeps } from "@len3hq/covenant-sdk";

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
  solana?: SolanaDeps;
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
  const store = new SpendStore(world.spendsFile);
  const payer = new Payer({
    vault: world.vault,
    store,
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
    heldCoins: () => store.heldCoins(),
    ...(world.solana ? { solana: { ...world.solana, heldNonces: () => store.heldNonces() } } : {}),
    onSpend: (asset, to, report) => spends.push({ asset, to, report }),
  });
  return { tools, spends };
}

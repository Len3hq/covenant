import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { hex } from "@scure/base";
import { networks, payments, Transaction } from "bitcoinjs-lib";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { z } from "zod";
import type { World } from "./runtime.js";
import { connectVault } from "@covenant/sdk";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA = 84532;
/** Coins the simulated Bitcoin chain says the vault holds. */
const COINS = [400_000n, 300_000n, 200_000n];
const READY_TIMEOUT_MS = 600_000;

const readySchema = z.object({
  rpcUrl: z.string(),
  vault: z.string(),
  agent: z.object({ id: z.string(), key: z.string() }),
  owner: z.object({ id: z.string(), key: z.string() }),
});

/** Starts the Rust sandbox helper and waits for it to report the deployed vault. */
async function startSandbox() {
  const child = spawn(
    "cargo",
    ["run", "-q", "-p", "covenant-integration-tests", "--example", "sandbox"],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the sandbox didn't start in time")), READY_TIMEOUT_MS);
    child.once("exit", (code) => reject(new Error(`the sandbox exited with code ${code}`)));
    lines.on("line", (line) => {
      try {
        const parsed = readySchema.safeParse(JSON.parse(line));
        if (parsed.success) {
          clearTimeout(timer);
          resolve(parsed.data);
        }
      } catch {
        // Not the ready line.
      }
    });
  });
  return { ready, stop: () => child.stdin.end() };
}

/** A previous transaction paying the vault one coin, as a funding transaction would. */
function fundingTx(script: Uint8Array, value: bigint, salt: number): Transaction {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(new Uint8Array(32).fill(salt), 0);
  tx.addOutput(script, value);
  return tx;
}

/**
 * The real contract on a local NEAR sandbox, signing through the mock signer. Bitcoin and Base are
 * simulated, so nothing is broadcast and no key the demo uses controls anything real.
 */
export async function sandboxWorld(): Promise<World> {
  const { ready, stop } = await startSandbox();
  const vault = connectVault({
    rpcUrl: ready.rpcUrl,
    vault: ready.vault,
    agent: ready.agent.id,
    agentKey: ready.agent.key,
  });
  const pubkey = await vault.btcPubkey();
  const own = payments.p2wpkh({ pubkey, network: networks.testnet });
  if (!own.output) throw new Error("could not derive the vault script");
  const funding = COINS.map((value, index) => fundingTx(own.output as Uint8Array, value, index + 1));
  let nonce = 0;
  const owner = new Account(
    ready.owner.id,
    new JsonRpcProvider({ url: ready.rpcUrl }),
    ready.owner.key as KeyPairString,
  );

  return {
    name: "sandbox",
    vault,
    usdc: USDC,
    spendsFile: join(mkdtempSync(join(tmpdir(), "covenant-demo-")), "spends.json"),
    mempool: {
      spendableUtxos: async () =>
        funding.map((tx, index) => ({ txid: tx.getId(), vout: 0, value: COINS[index] ?? 0n })),
      txHex: async (txid) => {
        const tx = funding.find((candidate) => candidate.getId() === txid);
        if (!tx) throw new Error(`no simulated transaction ${txid}`);
        return tx.toHex();
      },
      feeRate: async () => 2n,
      broadcast: async () => "not broadcast",
    },
    chain: {
      chainId: BASE_SEPOLIA,
      pendingNonce: async () => nonce++,
      fees: async () => ({ maxFeePerGas: 6_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      estimateGas: async () => 65_000n,
      broadcast: async () => "0x",
    },
    reads: {
      btcBalance: async () => COINS.reduce((total, value) => total + value, 0n),
      ethBalance: async () => 50_000_000_000_000_000n,
      tokenBalance: async () => 20_000_000n,
    },
    broadcast: { bitcoin: async () => "not broadcast", evm: async () => "not broadcast" },
    // The mock signer's signatures aren't real, so they're recorded instead of being checked.
    assemble: async (prepared, signatures) => ({
      signedHex: "",
      chainTx: `sandbox, ${signatures.length} mock signature(s), ${hex.encode(new TextEncoder().encode(prepared.chain))}`,
    }),
    links: () => ({}),
    veto: async (id) => {
      await owner.callFunction({ contractId: ready.vault, methodName: "veto", args: { id } });
    },
    stop,
  };
}

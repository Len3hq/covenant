import { hex } from "@scure/base";
import type { Address, Hex } from "viem";
import type { BitcoinPrepared } from "./bitcoin/pay.js";
import { signBitcoin } from "./bitcoin/pay.js";
import { signEvm } from "./evm/pay.js";
import type { Log } from "./log.js";
import type { Prepared, SpendRecord, SpendStore } from "./store.js";
import { signSolana, type SolanaPrepared } from "./solana/pay.js";
import { ContractPanic, ecdsa, type AgentVault, type Proposed, type VaultSignature } from "./vault.js";

const ALREADY_KNOWN = /already known|already in (block|mempool|chain)|txn-already|known transaction/i;

export interface Links {
  near?: string;
  chain?: string;
}

/** What the model and the logs are told about a spend. */
export interface SpendReport {
  status: SpendRecord["status"];
  id?: string;
  executableAt?: string;
  error?: string;
  chainTx?: string;
  links: Links;
}

export function links(record: Pick<SpendRecord, "prepared" | "nearTx" | "chainTx">): Links {
  const { prepared, nearTx, chainTx } = record;
  const chain = {
    Bitcoin: `https://mempool.space/testnet4/tx/${chainTx}`,
    Evm: `https://sepolia.basescan.org/tx/${chainTx}`,
    Solana: `https://explorer.solana.com/tx/${chainTx}?cluster=devnet`,
  }[prepared.chain];
  return {
    ...(nearTx ? { near: `https://testnet.nearblocks.io/txns/${nearTx}` } : {}),
    ...(chainTx ? { chain } : {}),
  };
}

export const report = (record: SpendRecord, linker = links): SpendReport => ({
  status: record.status,
  ...(record.id ? { id: record.id } : {}),
  ...(record.executableAt ? { executableAt: record.executableAt } : {}),
  ...(record.error ? { error: record.error } : {}),
  ...(record.chainTx ? { chainTx: record.chainTx } : {}),
  links: linker(record),
});

/** Turns signatures into a broadcastable transaction. Live, this checks each signature first. */
export type Assemble = (
  prepared: Prepared,
  signatures: VaultSignature[],
) => Promise<{ signedHex: string; chainTx: string }>;

export interface Broadcasters {
  bitcoin(signedHex: string): Promise<string>;
  evm(signedHex: Hex): Promise<string>;
  /** Resolves once the transaction is confirmed, so its nonce account has advanced. */
  solana(signedHex: string): Promise<string>;
}

/**
 * Takes each spend through its steps, recording each one first. A spend already on record resumes
 * from where it stopped, and is never proposed a second time.
 */
export class Payer {
  private readonly vault: AgentVault;
  private readonly store: SpendStore;
  private readonly broadcast: Broadcasters;
  private readonly log: Log;
  private readonly assembleWith?: Assemble;
  private readonly linker: typeof links;

  constructor(deps: {
    vault: AgentVault;
    store: SpendStore;
    broadcast: Broadcasters;
    log: Log;
    /** Replaces the live assembly; the sandbox's mock signatures can't be checked. */
    assemble?: Assemble;
    links?: typeof links;
  }) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.broadcast = deps.broadcast;
    this.log = deps.log;
    if (deps.assemble) this.assembleWith = deps.assemble;
    this.linker = deps.links ?? links;
  }

  private report(record: SpendRecord): SpendReport {
    return report(record, this.linker);
  }

  async spend(
    key: string,
    description: string,
    prepare: () => Promise<Prepared>,
  ): Promise<SpendReport> {
    const existing = this.store.get(key);
    if (existing && existing.status !== "failed") return this.resume(existing);
    const record: SpendRecord = { key, description, status: "prepared", prepared: await prepare() };
    this.store.put(record);
    return this.propose(record);
  }

  /** Signs a queued spend whose veto window has passed. */
  async execute(id: string): Promise<SpendReport> {
    const record = this.store.byId(id);
    if (!record) throw new Error(`no record of spend ${id}`);
    if (record.status !== "queued") return this.resume(record);
    return this.settle(record, async () =>
      this.vault.execute(id, (nearTx) => {
        this.store.put({ ...record, status: "executing", nearTx });
      }),
    );
  }

  private async resume(record: SpendRecord): Promise<SpendReport> {
    this.log("spend_resumed", { key: record.key, status: record.status, id: record.id });
    switch (record.status) {
      case "prepared":
        return this.propose(record);
      case "proposing":
      case "executing":
        if (!record.nearTx) throw new Error(`${record.key} has no NEAR transaction on record`);
        return this.settle(record, () => this.vault.recover(record.nearTx as string));
      case "signed":
        return this.send(record);
      default:
        return this.report(record);
    }
  }

  private propose(record: SpendRecord): Promise<SpendReport> {
    const { prepared } = record;
    const beforeSend = (nearTx: string) => {
      this.store.put({ ...record, status: "proposing", nearTx });
    };
    return this.settle(record, () =>
      prepared.chain === "Bitcoin"
        ? this.vault.proposeBitcoin(
            {
              tx: hex.decode(prepared.unsignedHex),
              prevTxs: prepared.prevTxs.map((prev) => hex.decode(prev)),
            },
            beforeSend,
          )
        : prepared.chain === "Solana"
          ? this.vault.proposeSolana(hex.decode(prepared.unsignedHex), beforeSend)
          : this.vault.proposeEvm(hex.decode(prepared.unsignedHex.slice(2)), beforeSend),
    );
  }

  private async settle(record: SpendRecord, call: () => Promise<Proposed>): Promise<SpendReport> {
    let proposed: Proposed;
    try {
      proposed = await call();
    } catch (error) {
      if (!(error instanceof ContractPanic)) throw error;
      const failed: SpendRecord = {
        ...(this.store.get(record.key) ?? record),
        status: record.status === "queued" ? "queued" : "failed",
        error: panicName(error),
      };
      this.store.put(failed);
      this.log("spend_failed", { key: record.key, error: failed.error });
      return this.report(failed);
    }
    const { outcome, nearTx } = proposed;
    const base: SpendRecord = { ...record, nearTx };
    const { chain } = record.prepared;
    if ("Rejected" in outcome) {
      // Too early isn't final: the spend stays queued, and can be executed when its time comes.
      const waiting = outcome.Rejected === "NotYetExecutable";
      const next: SpendRecord = {
        ...base,
        status: waiting ? "queued" : "rejected",
        error: outcome.Rejected,
      };
      this.store.put(next);
      this.log("spend_rejected", { id: next.id, chain, error: outcome.Rejected, nearTx });
      return this.report(next);
    }
    if ("Queued" in outcome) {
      const { id, executable_at: executableAt } = outcome.Queued;
      const next: SpendRecord = { ...base, status: "queued", id, executableAt };
      this.store.put(next);
      this.log("spend_queued", { id, chain, executableAt, nearTx });
      return this.report(next);
    }
    const { id, signatures } = outcome.Signed;
    const assembled = await this.assemble(record.prepared, signatures);
    const signed: SpendRecord = { ...base, status: "signed", id, ...assembled };
    delete signed.error;
    this.store.put(signed);
    this.log("spend_signed", { id, chain, nearTx, chainTx: assembled.chainTx });
    return this.send(signed);
  }

  private async assemble(
    prepared: Prepared,
    signatures: VaultSignature[],
  ): Promise<{ signedHex: string; chainTx: string }> {
    if (this.assembleWith) return this.assembleWith(prepared, signatures);
    if (prepared.chain === "Bitcoin") {
      return signBitcoin(prepared satisfies BitcoinPrepared, ecdsa(signatures), await this.vault.btcPubkey());
    }
    if (prepared.chain === "Solana") {
      return signSolana(prepared satisfies SolanaPrepared, signatures, await this.vault.solPubkey());
    }
    const from = (await this.vault.evmAddress()) as Address;
    return signEvm(prepared.unsignedHex as Hex, ecdsa(signatures), from);
  }

  private async send(record: SpendRecord): Promise<SpendReport> {
    const signedHex = record.signedHex as string;
    try {
      const { chain } = record.prepared;
      if (chain === "Bitcoin") await this.broadcast.bitcoin(signedHex);
      else if (chain === "Solana") await this.broadcast.solana(signedHex);
      else await this.broadcast.evm(signedHex as Hex);
    } catch (error) {
      if (!ALREADY_KNOWN.test(String(error))) throw error;
    }
    const sent: SpendRecord = { ...record, status: "broadcast" };
    this.store.put(sent);
    this.log("spend_broadcast", { id: sent.id, chainTx: sent.chainTx });
    return this.report(sent);
  }
}

/** The `CovenantError` name inside a NEAR failure, or the raw failure if there isn't one. */
function panicName(error: ContractPanic): string {
  return /Smart contract panicked: (\w+)/.exec(error.message)?.[1] ?? error.message;
}

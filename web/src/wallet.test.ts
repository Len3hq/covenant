import { describe, expect, it, vi } from "vitest";
import type { VaultState } from "./vault";
import { act, canStop, daoProposal, parsePolicy, roleOf, vaultCall, type Transaction } from "./wallet";

const vault = {
  roles: { owner: "owner.testnet", guardian: "dao.testnet", agent: "agent.testnet" },
  guardianDao: { accountId: "dao.testnet", council: ["member.testnet"], proposalBond: "7", nextProposalId: 4 },
} as VaultState;

describe("roleOf", () => {
  it("recognises each role, and gives the agent none", () => {
    expect(roleOf("owner.testnet", vault)).toBe("owner");
    expect(roleOf("dao.testnet", vault)).toBe("guardian");
    expect(roleOf("member.testnet", vault)).toBe("council");
    expect(roleOf("agent.testnet", vault)).toBe("none");
    expect(roleOf(null, vault)).toBe("none");
    expect(canStop("none")).toBe(false);
  });
});

describe("act", () => {
  const run = (role: "owner" | "council", found: number | null) => {
    const sent: Transaction[] = [];
    const findProposal = vi.fn(async () => found);
    const done = act({
      rpcUrl: "rpc",
      role,
      account: "member.testnet",
      vault: "vault",
      state: vault,
      method: "veto",
      args: { id: "3" },
      findProposal,
      sendWith: async (_rpc, transaction) => {
        sent.push(transaction);
      },
    });
    return { done, sent, findProposal };
  };

  it("calls the vault directly for the owner, with no deposit", async () => {
    const { done, sent } = run("owner", null);
    await done;
    expect(sent).toEqual([vaultCall("vault", "veto", { id: "3" })]);
    expect(sent[0]?.actions[0]?.params.deposit).toBe("0");
  });

  it("votes for the proposal it found by its own description, not the id it expected", async () => {
    const { done, sent, findProposal } = run("council", 9);
    await done;
    const [propose, vote] = sent;
    expect(propose?.actions[0]?.params).toMatchObject({ methodName: "add_proposal", deposit: "7" });
    const { description } = (propose?.actions[0]?.params.args as { proposal: { description: string } }).proposal;
    expect(findProposal).toHaveBeenCalledWith("dao.testnet", 4, "member.testnet", description);
    expect(vote?.actions[0]?.params.args).toMatchObject({ id: 9, action: "VoteApprove" });
  });

  it("votes for nothing when it can't find its own proposal", async () => {
    const { done, sent } = run("council", null);
    await expect(done).rejects.toThrow("nothing was voted on");
    expect(sent).toHaveLength(1);
  });
});

describe("daoProposal", () => {
  it("targets the vault, encodes its arguments, and makes each description unique", () => {
    const { kind, description } = daoProposal("vault", "veto", { id: "3" }, "n1");
    const [action] = kind.FunctionCall.actions;
    expect(kind.FunctionCall.receiver_id).toBe("vault");
    expect(JSON.parse(atob(action?.args ?? ""))).toEqual({ id: "3" });
    expect(description).not.toBe(daoProposal("vault", "veto", { id: "3" }, "n2").description);
  });
});

describe("parsePolicy", () => {
  it("accepts a policy's shape and refuses anything else", () => {
    expect(parsePolicy('{"caps":[],"payees":[]}')).toEqual({ caps: [], payees: [] });
    expect(() => parsePolicy('{"caps":[]}')).toThrow("caps and payees");
    expect(() => parsePolicy("not json")).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type { VaultState } from "./vault";
import { canStop, daoCall, parsePolicy, roleOf, transactionsFor, vaultCall } from "./wallet";

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

describe("transactionsFor", () => {
  it("calls the vault directly for the owner, with no deposit", () => {
    expect(transactionsFor("owner", "vault", vault, "veto", { id: "3" })).toEqual([
      vaultCall("vault", "veto", { id: "3" }),
    ]);
    expect(vaultCall("vault", "veto", { id: "3" }).actions[0]?.params.deposit).toBe("0");
  });

  it("proposes and votes for a council member, using the DAO's bond and next id", () => {
    const [propose, vote] = transactionsFor("council", "vault", vault, "veto", { id: "3" });
    expect(propose?.receiverId).toBe("dao.testnet");
    expect(propose?.actions[0]?.params.methodName).toBe("add_proposal");
    expect(propose?.actions[0]?.params.deposit).toBe("7");
    expect(vote?.actions[0]?.params.methodName).toBe("act_proposal");
    expect(vote?.actions[0]?.params.args).toMatchObject({ id: 4, action: "VoteApprove" });
  });

  it("encodes the vault's arguments as the DAO expects, and targets the vault", () => {
    const [propose] = daoCall("vault", { accountId: "d", proposalBond: "1", nextProposalId: 0 }, "veto", { id: "3" });
    const args = propose?.actions[0]?.params.args as {
      proposal: { kind: { FunctionCall: { receiver_id: string; actions: { args: string }[] } } };
    };
    const { receiver_id, actions } = args.proposal.kind.FunctionCall;
    expect(receiver_id).toBe("vault");
    expect(JSON.parse(atob(actions[0]?.args ?? ""))).toEqual({ id: "3" });
  });
});

describe("parsePolicy", () => {
  it("accepts a policy's shape and refuses anything else", () => {
    expect(parsePolicy('{"caps":[],"payees":[]}')).toEqual({ caps: [], payees: [] });
    expect(() => parsePolicy('{"caps":[]}')).toThrow("caps and payees");
    expect(() => parsePolicy("not json")).toThrow();
  });
});

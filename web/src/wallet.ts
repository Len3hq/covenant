import type { NearConnector } from "@hot-labs/near-connect";
import type { Policy, VaultState } from "./vault";

const CALL_GAS = "30000000000000";
const VOTE_GAS = "150000000000000";
const DAO_ACTION_GAS = "50000000000000";
const CREATE_VAULT_GAS = "300000000000000";

/** What the connected account can do. The contract enforces this; the page only hides buttons. */
export type Role = "owner" | "guardian" | "council" | "none";

export function roleOf(account: string | null, vault: VaultState): Role {
  if (!account) return "none";
  if (account === vault.roles.owner) return "owner";
  if (account === vault.roles.guardian) return "guardian";
  return vault.guardianDao?.council.includes(account) ? "council" : "none";
}

export const canStop = (role: Role) => role !== "none";

export interface FunctionCall {
  type: "FunctionCall";
  params: { methodName: string; args: object; gas: string; deposit: string };
}

export interface Transaction {
  receiverId: string;
  actions: FunctionCall[];
}

const call = (methodName: string, args: object, gas = CALL_GAS, deposit = "0"): FunctionCall => ({
  type: "FunctionCall",
  params: { methodName, args, gas, deposit },
});

/** A call the vault receives directly from the signer. */
export function vaultCall(vault: string, method: string, args: object): Transaction {
  return { receiverId: vault, actions: [call(method, args)] };
}

/** Asks the factory for a vault, with the caller as its owner. */
export function createVaultCall(factory: string, args: object, deposit: string): Transaction {
  return { receiverId: factory, actions: [call("create_vault", args, CREATE_VAULT_GAS, deposit)] };
}

/** The DAO proposal for a guardian action, with a description that identifies it. */
export function daoProposal(vault: string, method: string, args: object, nonce: string) {
  const kind = {
    FunctionCall: {
      receiver_id: vault,
      actions: [
        {
          method_name: method,
          args: btoa(JSON.stringify(args)),
          deposit: "0",
          gas: DAO_ACTION_GAS,
        },
      ],
    },
  };
  return { kind, description: `Guardian: ${method} on ${vault} (${nonce})` };
}

export function proposeCall(dao: { accountId: string; proposalBond: string }, proposal: object): Transaction {
  return {
    receiverId: dao.accountId,
    actions: [call("add_proposal", { proposal }, CALL_GAS, dao.proposalBond)],
  };
}

export function voteCall(dao: { accountId: string }, id: number, kind: object): Transaction {
  return {
    receiverId: dao.accountId,
    actions: [call("act_proposal", { id, action: "VoteApprove", proposal: kind }, VOTE_GAS)],
  };
}

/** Reads a policy someone typed. It only checks the shape; the contract validates the rules. */
export function parsePolicy(text: string): Policy {
  const parsed = JSON.parse(text) as Partial<Policy>;
  if (!Array.isArray(parsed.caps) || !Array.isArray(parsed.payees)) {
    throw new Error("A policy needs caps and payees lists");
  }
  return parsed as Policy;
}

let connector: Promise<NearConnector> | undefined;

/** Loaded on first use, because the connector touches browser-only APIs as it starts. */
export function walletConnector(rpcUrl: string): Promise<NearConnector> {
  connector ??= import("@hot-labs/near-connect").then(
    ({ NearConnector: Connector }) =>
      new Connector({
        network: "testnet",
        providers: { testnet: [rpcUrl] },
        features: { signAndSendTransaction: true, testnet: true },
      }),
  );
  return connector;
}

export async function connectedAccount(rpcUrl: string): Promise<string | null> {
  try {
    const { accounts } = await (await walletConnector(rpcUrl)).getConnectedWallet();
    return accounts[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

export async function send(rpcUrl: string, transaction: Transaction): Promise<void> {
  const wallet = await (await walletConnector(rpcUrl)).wallet();
  await wallet.signAndSendTransaction(transaction);
}

/**
 * Makes `method` happen for this role. A council member proposes, then votes for the proposal
 * found by its own description and proposer. Anyone may add proposals, so guessing the next id
 * could approve someone else's.
 */
export async function act(args: {
  rpcUrl: string;
  role: Role;
  account: string;
  vault: string;
  state: VaultState;
  method: string;
  args: object;
  findProposal: (dao: string, from: number, proposer: string, description: string) => Promise<number | null>;
  sendWith?: typeof send;
}): Promise<void> {
  const sender = args.sendWith ?? send;
  const dao = args.state.guardianDao;
  if (args.role !== "council" || !dao) {
    await sender(args.rpcUrl, vaultCall(args.vault, args.method, args.args));
    return;
  }
  const { kind, description } = daoProposal(args.vault, args.method, args.args, crypto.randomUUID());
  await sender(args.rpcUrl, proposeCall(dao, { description, kind }));
  const id = await args.findProposal(dao.accountId, dao.nextProposalId, args.account, description);
  if (id === null) throw new Error("couldn't find the proposal just added, so nothing was voted on");
  await sender(args.rpcUrl, voteCall(dao, id, kind));
}

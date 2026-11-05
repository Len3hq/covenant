import type { NearConnector } from "@hot-labs/near-connect";
import type { Policy, VaultState } from "./vault";

const CALL_GAS = "30000000000000";
const VOTE_GAS = "150000000000000";
const DAO_ACTION_GAS = "50000000000000";

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

/** The same call made by the guardian DAO: a council member proposes it, then votes it through. */
export function daoCall(
  vault: string,
  dao: { accountId: string; proposalBond: string; nextProposalId: number },
  method: string,
  args: object,
): Transaction[] {
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
  const proposal = { description: `Guardian: ${method} on ${vault}`, kind };
  return [
    {
      receiverId: dao.accountId,
      actions: [call("add_proposal", { proposal }, CALL_GAS, dao.proposalBond)],
    },
    {
      receiverId: dao.accountId,
      actions: [
        call("act_proposal", { id: dao.nextProposalId, action: "VoteApprove", proposal: kind }, VOTE_GAS),
      ],
    },
  ];
}

/** The transactions that make `method` happen for this role, in order. */
export function transactionsFor(
  role: Role,
  vault: string,
  state: VaultState,
  method: string,
  args: object,
): Transaction[] {
  if (role === "council" && state.guardianDao) {
    return daoCall(vault, state.guardianDao, method, args);
  }
  return [vaultCall(vault, method, args)];
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

export async function send(rpcUrl: string, transactions: Transaction[]): Promise<void> {
  const wallet = await (await walletConnector(rpcUrl)).wallet();
  // One at a time, because a vote can only follow the proposal it votes on.
  for (const transaction of transactions) {
    await wallet.signAndSendTransaction(transaction);
  }
}

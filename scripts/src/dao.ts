// Acts as the guardian through its Sputnik DAO: a council member proposes a call to the vault and
// votes it through. The bond comes back once the proposal passes.
import { randomUUID } from "node:crypto";
import { callContract, requireEnv, viewCall } from "./near.ts";

const BOND = "1 NEAR";
const PROPOSE_GAS = "30 Tgas";
const VOTE_GAS = "150 Tgas";
const ACTION_GAS = "50000000000000";
const SEARCH_LIMIT = 50;

const dao = requireEnv("GUARDIAN_DAO_ID");
const member = requireEnv("GUARDIAN_ACCOUNT_ID");
const vault = requireEnv("VAULT_ACCOUNT_ID");
const rpcUrl = requireEnv("NEAR_RPC_URL");
const [command, value] = process.argv.slice(2);

async function act(method: string, args: unknown): Promise<void> {
  const kind = {
    FunctionCall: {
      receiver_id: vault,
      actions: [
        {
          method_name: method,
          args: Buffer.from(JSON.stringify(args)).toString("base64"),
          deposit: "0",
          gas: ACTION_GAS,
        },
      ],
    },
  };
  const from = await viewCall<number>(rpcUrl, dao, "get_last_proposal_id", {});
  // Anyone may add a proposal, so the vote must go to the one this call made, found by a unique
  // description and its proposer. Guessing the next id could approve someone else's.
  const description = `Guardian: ${method} on ${vault} (${randomUUID()})`;
  callContract(
    member,
    dao,
    "add_proposal",
    { proposal: { description, kind } },
    { gas: PROPOSE_GAS, deposit: BOND },
  );
  const proposals = await viewCall<{ id: number; proposer: string; description: string }[]>(
    rpcUrl,
    dao,
    "get_proposals",
    { from_index: from, limit: SEARCH_LIMIT },
  );
  const mine = proposals.find((p) => p.proposer === member && p.description === description);
  if (!mine) throw new Error("couldn't find the proposal just added, so nothing was voted on");
  const { id } = mine;
  callContract(
    member,
    dao,
    "act_proposal",
    { id, action: "VoteApprove", proposal: kind },
    { gas: VOTE_GAS },
  );
  const { status } = await viewCall<{ status: string }>(rpcUrl, dao, "get_proposal", { id });
  console.log(`Proposal ${id}: ${status}`);
  if (status !== "Approved") throw new Error(`proposal ${id} ended as ${status}`);
}

if (command === "freeze") {
  await act("freeze", {});
} else if (command === "veto") {
  if (!value) throw new Error("dao-veto needs ID=<spend id>");
  await act("veto", { id: value });
} else {
  throw new Error(`unknown command: ${command}`);
}

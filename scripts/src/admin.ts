// The human controls on the live vault. `AS` picks the signer, which defaults to the owner, so
// `AS=guardian.len3hq.testnet make freeze` proves the guardian's powers.
import { callVault, requireEnv } from "./near.ts";

const signer = process.env.AS || requireEnv("OWNER_ACCOUNT_ID");
const [command, value] = process.argv.slice(2);

function required(name: string): string {
  if (!value) throw new Error(`${command} needs ${name}`);
  return value;
}

switch (command) {
  case "veto":
    callVault(signer, "veto", { id: required("ID=<spend id>") });
    break;
  case "freeze":
  case "unfreeze":
    callVault(signer, command, {});
    break;
  case "set-guardian":
    callVault(signer, "set_guardian", { guardian: required("GUARDIAN=<account>") });
    break;
  default:
    throw new Error(`unknown command: ${command}`);
}

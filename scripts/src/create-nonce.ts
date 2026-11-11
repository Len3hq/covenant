// Creates a durable nonce account whose authority is the vault, so its Solana payments can land
// even after a veto window. A local funder key pays the rent; it never controls the vault's funds.
// Run it once per payment the agent may have in flight at a time. ENV_FILE names the vault's settings
// file, which gets the new account, so a second vault's nonces don't land in the first one's list.
import { base58 } from "@scure/base";
import { Connection, Keypair, LAMPORTS_PER_SOL, NONCE_ACCOUNT_LENGTH, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
import { requireEnv, viewCall } from "./near.ts";

const ENV_FILE = process.env.ENV_FILE || ".env";
const FEES = 20_000;

function setEnv(name: string, value: string) {
  const env = readFileSync(ENV_FILE, "utf8");
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(ENV_FILE, pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}\n${line}\n`);
}

const vault = requireEnv("VAULT_ACCOUNT_ID");
const { sol_address: solAddress } = await viewCall<{ sol_address?: string }>(
  requireEnv("NEAR_RPC_URL"),
  vault,
  "get_addresses",
  {},
);
if (!solAddress) throw new Error(`${vault} runs code from before Solana support; run \`make deploy\` to migrate it`);

const connection = new Connection(process.env.SOL_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);

let funder: Keypair;
if (process.env.SOL_FUNDER_KEY) {
  funder = Keypair.fromSecretKey(base58.decode(process.env.SOL_FUNDER_KEY));
} else {
  funder = Keypair.generate();
  setEnv("SOL_FUNDER_KEY", base58.encode(funder.secretKey));
}
const balance = await connection.getBalance(funder.publicKey);
if (balance < rent + FEES) {
  console.log(
    `The funder ${funder.publicKey.toBase58()} holds ${balance / LAMPORTS_PER_SOL} SOL and needs ${(rent + FEES) / LAMPORTS_PER_SOL}.\n` +
      "Fund it with devnet SOL at https://faucet.solana.com, then run `make sol-nonce` again. Its key is in .env.",
  );
  process.exit(1);
}

const nonce = Keypair.generate();
const tx = new Transaction().add(
  ...SystemProgram.createNonceAccount({
    fromPubkey: funder.publicKey,
    noncePubkey: nonce.publicKey,
    authorizedPubkey: new PublicKey(solAddress),
    lamports: rent,
  }).instructions,
);
const signature = await sendAndConfirmTransaction(connection, tx, [funder, nonce]);

const accounts = (process.env.SOL_NONCE_ACCOUNTS ?? "").split(",").map((a) => a.trim()).filter(Boolean);
setEnv("SOL_NONCE_ACCOUNTS", [...accounts, nonce.publicKey.toBase58()].join(","));
console.log(
  JSON.stringify(
    {
      vault,
      sol_address: solAddress,
      nonce_account: nonce.publicKey.toBase58(),
      transaction: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    },
    null,
    2,
  ),
);

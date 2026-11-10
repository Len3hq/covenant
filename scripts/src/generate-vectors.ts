// Writes tests/vectors/btc_sighash.json, evm_hash.json and solana_message.json from libraries the
// contract doesn't use,
// so its hashes are checked against an outside implementation. Inputs are fixed, so the output is
// reproducible: run `pnpm --filter @covenant/scripts vectors` and expect no diff.
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { Transaction } from "bitcoinjs-lib";
import { writeFileSync } from "node:fs";
import { keccak256, serializeTransaction, type TransactionSerializableEIP1559 } from "viem";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction as SolanaTransaction,
  TransactionInstruction,
} from "@solana/web3.js";

const OUT = new URL("../../tests/vectors/", import.meta.url);

/** The P2WPKH key from BIP143's own example. Only its hash matters here. */
const PUBKEY = hex.decode("025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357");
const PUBKEY_HASH = ripemd160(sha256(PUBKEY));
const VAULT_SCRIPT = Uint8Array.from([0x00, 0x14, ...PUBKEY_HASH]);
const SCRIPT_CODE = Uint8Array.from([0x76, 0xa9, 0x14, ...PUBKEY_HASH, 0x88, 0xac]);
const SIGHASH_ALL = 1;

const p2wpkh = (fill: number) => Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(fill)]);
const p2tr = (fill: number) => Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(fill)]);
const p2sh = (fill: number) => Uint8Array.from([0xa9, 0x14, ...new Uint8Array(20).fill(fill), 0x87]);

interface BitcoinCase {
  name: string;
  version: number;
  inputs: { amount: bigint; sequence: number }[];
  outputs: { script: Uint8Array; amount: bigint }[];
}

const bitcoinCases: BitcoinCase[] = [
  {
    name: "one input, one payee",
    version: 2,
    inputs: [{ amount: 100_000n, sequence: 0xfffffffd }],
    outputs: [{ script: p2wpkh(0xaa), amount: 99_000n }],
  },
  {
    name: "two inputs, payee and change",
    version: 2,
    inputs: [
      { amount: 500_000n, sequence: 0xfffffffd },
      { amount: 254_051n, sequence: 0xfffffffd },
    ],
    outputs: [
      { script: p2wpkh(0xaa), amount: 600_000n },
      { script: VAULT_SCRIPT, amount: 153_000n },
    ],
  },
  {
    name: "three inputs, eight outputs, every script type, version 1",
    version: 1,
    inputs: [
      { amount: 1_000_000n, sequence: 0xffffffff },
      { amount: 2_000_000n, sequence: 0xfffffffe },
      { amount: 3_000_000n, sequence: 0 },
    ],
    outputs: [
      { script: p2wpkh(0xa1), amount: 1_000n },
      { script: p2tr(0xa2), amount: 2_000n },
      { script: p2sh(0xa3), amount: 3_000n },
      { script: p2wpkh(0xa4), amount: 4_000n },
      { script: p2tr(0xa5), amount: 5_000n },
      { script: p2sh(0xa6), amount: 6_000n },
      { script: p2wpkh(0xa7), amount: 7_000n },
      { script: VAULT_SCRIPT, amount: 5_900_000n },
    ],
  },
  {
    name: "amounts above 32 bits",
    version: 2,
    inputs: [
      { amount: 2_100_000_000_000n, sequence: 0xfffffffd },
      { amount: 5_000_000_000n, sequence: 0xfffffffd },
    ],
    outputs: [
      { script: p2tr(0xbb), amount: 2_000_000_000_000n },
      { script: VAULT_SCRIPT, amount: 104_999_990_000n },
    ],
  },
];

function fundingTx(amount: bigint, salt: number): Transaction {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(new Uint8Array(32).fill(salt), 0, 0xffffffff, Uint8Array.from([0x51]));
  tx.addOutput(p2wpkh(0xee), 1_000n);
  tx.addOutput(VAULT_SCRIPT, amount);
  return tx;
}

function bitcoinVector(testCase: BitcoinCase, caseIndex: number) {
  const tx = new Transaction();
  tx.version = testCase.version;
  const funding = testCase.inputs.map((input, i) => {
    const prev = fundingTx(input.amount, 16 * caseIndex + i + 1);
    tx.addInput(prev.getHash(), 1, input.sequence);
    return prev;
  });
  for (const output of testCase.outputs) tx.addOutput(output.script, output.amount);

  return {
    name: testCase.name,
    pubkey: hex.encode(PUBKEY),
    unsigned_tx: tx.toHex(),
    prev_txs: funding.map((prev) => prev.toHex()),
    payees: testCase.outputs
      .filter((output) => hex.encode(output.script) !== hex.encode(VAULT_SCRIPT))
      .map((output) => hex.encode(output.script)),
    sighashes: testCase.inputs.map((input, i) =>
      hex.encode(tx.hashForWitnessV0(i, SCRIPT_CODE, input.amount, SIGHASH_ALL)),
    ),
  };
}

const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const PAYEE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function transferData(to: string, amount: bigint): `0x${string}` {
  const word = amount.toString(16).padStart(64, "0");
  return `0xa9059cbb${to.slice(2).padStart(64, "0")}${word}`;
}

const base = {
  type: "eip1559",
  chainId: 84532,
  nonce: 7,
  maxPriorityFeePerGas: 1_000_000n,
  maxFeePerGas: 6_000_000n,
  gas: 21_000n,
  to: PAYEE,
} satisfies TransactionSerializableEIP1559;

const usdc = {
  ...base,
  gas: 65_000n,
  to: USDC,
  value: 0n,
} satisfies TransactionSerializableEIP1559;

const evmCases: { name: string; tx: TransactionSerializableEIP1559; amount: bigint }[] = [
  {
    name: "native transfer",
    tx: { ...base, value: 5_000_000_000_000_000n },
    amount: 5_000_000_000_000_000n,
  },
  {
    name: "USDC transfer",
    tx: { ...usdc, data: transferData(PAYEE, 10_000_000n) },
    amount: 10_000_000n,
  },
  {
    name: "first transaction: nonce and priority fee zero",
    tx: { ...base, nonce: 0, maxPriorityFeePerGas: 0n, value: 1n },
    amount: 1n,
  },
  {
    name: "another chain, value above 64 bits",
    tx: { ...base, chainId: 8453, nonce: 1_000_000, value: 1n << 70n },
    amount: 1n << 70n,
  },
  {
    name: "USDC transfer with a high nonce and fee",
    tx: {
      ...usdc,
      nonce: 2 ** 32,
      maxFeePerGas: 1_000_000_000n,
      data: transferData(PAYEE, 1_000_000_000_000n),
    },
    amount: 1_000_000_000_000n,
  },
];

function evmVector({ name, tx, amount }: (typeof evmCases)[number]) {
  const serialized = serializeTransaction(tx);
  return {
    name,
    serialized: serialized.slice(2),
    hash: keccak256(serialized).slice(2),
    chain_id: tx.chainId,
    token: tx.data ? tx.to?.slice(2) : null,
    payee: PAYEE.slice(2),
    amount: amount.toString(),
    gas_cost: ((tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n)).toString(),
  };
}

function write(name: string, source: string, vectors: unknown[]) {
  const body = { description: `Generated by scripts/src/generate-vectors.ts with ${source}.`, vectors };
  writeFileSync(new URL(name, OUT), `${JSON.stringify(body, null, 2)}\n`);
}

// Solana: fixed keys, so the output is reproducible.
const solKey = (fill: number) => Keypair.fromSeed(new Uint8Array(32).fill(fill)).publicKey;
const SOL_VAULT = solKey(1);
const SOL_NONCE = solKey(2);
const SOL_PAYEE = solKey(3);
const NONCE_VALUE = new PublicKey(new Uint8Array(32).fill(0x55)).toBase58();
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SOL_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ata = (wallet: PublicKey) =>
  PublicKey.findProgramAddressSync([wallet.toBuffer(), TOKEN_PROGRAM.toBuffer(), SOL_USDC.toBuffer()], ATA_PROGRAM)[0];

function transferChecked(amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = 6;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: ata(SOL_VAULT), isSigner: false, isWritable: true },
      { pubkey: SOL_USDC, isSigner: false, isWritable: false },
      { pubkey: ata(SOL_PAYEE), isSigner: false, isWritable: true },
      { pubkey: SOL_VAULT, isSigner: true, isWritable: false },
    ],
    data,
  });
}

const solanaCases: {
  name: string;
  instructions: TransactionInstruction[];
  asset: "Sol" | "Spl";
  payee: PublicKey;
  amount: bigint;
  fee: bigint;
}[] = [
  {
    name: "SOL transfer",
    instructions: [SystemProgram.transfer({ fromPubkey: SOL_VAULT, toPubkey: SOL_PAYEE, lamports: 1_000_000n })],
    asset: "Sol",
    payee: SOL_PAYEE,
    amount: 1_000_000n,
    fee: 5_000n,
  },
  {
    name: "USDC transfer with a priority fee",
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000n }),
      transferChecked(2_500_000n),
    ],
    asset: "Spl",
    payee: ata(SOL_PAYEE),
    amount: 2_500_000n,
    fee: 25_000n,
  },
];

function solanaVector({ name, instructions, asset, payee, amount, fee }: (typeof solanaCases)[number]) {
  const tx = new SolanaTransaction({
    feePayer: SOL_VAULT,
    nonceInfo: {
      nonce: NONCE_VALUE,
      nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: SOL_NONCE, authorizedPubkey: SOL_VAULT }),
    },
  }).add(...instructions);
  return {
    name,
    message: tx.serializeMessage().toString("hex"),
    vault: SOL_VAULT.toBuffer().toString("hex"),
    nonce_account: SOL_NONCE.toBase58(),
    nonce: NONCE_VALUE,
    payee_wallet: SOL_PAYEE.toBase58(),
    payee: payee.toBuffer().toString("hex"),
    vault_token_account: ata(SOL_VAULT).toBase58(),
    asset,
    mint: asset === "Spl" ? SOL_USDC.toBuffer().toString("hex") : null,
    amount: amount.toString(),
    fee: fee.toString(),
  };
}

write("btc_sighash.json", "bitcoinjs-lib", bitcoinCases.map(bitcoinVector));
write("solana_message.json", "@solana/web3.js", solanaCases.map(solanaVector));
write("evm_hash.json", "viem", evmCases.map(evmVector));

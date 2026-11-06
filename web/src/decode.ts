import { base64 } from "@scure/base";
import type { Payment } from "./vault";

/*
 * Reads what the agent asked to pay from its propose_spend arguments, for display only.
 *
 * The contract refuses an unlisted address while parsing, before it has a payment list to log, so
 * its event for that refusal carries none. Decoding the request lets the log show the attacker's
 * address. Nothing here decides anything: the contract checks every byte itself.
 */

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  take(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new Error("short transaction");
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  /** Little-endian integer, as a decimal string so no float holds an amount. */
  uintLE(n: number): bigint {
    return this.take(n).reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
  }

  varint(): number {
    const first = this.take(1)[0] as number;
    if (first < 0xfd) return first;
    return Number(this.uintLE(first === 0xfd ? 2 : first === 0xfe ? 4 : 8));
  }
}

/** Every output of an unsigned Bitcoin transaction, as payments of its script. */
export function bitcoinOutputs(tx: Uint8Array): Payment[] {
  const reader = new Reader(tx);
  reader.take(4);
  let inputs = reader.varint();
  if (inputs === 0) {
    // A segwit marker and flag, then the real input count.
    reader.take(1);
    inputs = reader.varint();
  }
  for (let i = 0; i < inputs; i++) {
    reader.take(36);
    reader.take(reader.varint());
    reader.take(4);
  }
  const outputs = reader.varint();
  const payments: Payment[] = [];
  for (let i = 0; i < outputs; i++) {
    const amount = reader.uintLE(8);
    const script = reader.take(reader.varint());
    payments.push({ asset: "Btc", to: [...script], amount: amount.toString() });
  }
  return payments;
}

type Rlp = Uint8Array | Rlp[];

function rlp(bytes: Uint8Array, start = 0): { item: Rlp; end: number } {
  const prefix = bytes[start] as number;
  const length = (offset: number, size: number) =>
    Number(bytes.subarray(start + 1, start + 1 + size).reduce((v, b) => (v << 8n) | BigInt(b), 0n)) + offset;
  if (prefix < 0x80) return { item: bytes.subarray(start, start + 1), end: start + 1 };
  if (prefix <= 0xb7) {
    const end = start + 1 + prefix - 0x80;
    return { item: bytes.subarray(start + 1, end), end };
  }
  if (prefix <= 0xbf) {
    const size = prefix - 0xb7;
    const end = length(start + 1 + size, size);
    return { item: bytes.subarray(start + 1 + size, end), end };
  }
  const size = prefix <= 0xf7 ? 0 : prefix - 0xf7;
  const end = prefix <= 0xf7 ? start + 1 + prefix - 0xc0 : length(start + 1 + size, size);
  const items: Rlp[] = [];
  let at = start + 1 + size;
  while (at < end) {
    const next = rlp(bytes, at);
    items.push(next.item);
    at = next.end;
  }
  return { item: items, end };
}

const big = (bytes: Uint8Array) => bytes.reduce((v, b) => (v << 8n) | BigInt(b), 0n);
const TRANSFER = [0xa9, 0x05, 0x9c, 0xbb];

/** The payment in an unsigned EIP-1559 transaction: native value, or an ERC-20 transfer. */
export function evmPayments(tx: Uint8Array): Payment[] {
  if (tx[0] !== 0x02) return [];
  const { item } = rlp(tx, 1);
  if (!Array.isArray(item)) return [];
  const [chainId, , , , , to, value, data] = item as Uint8Array[];
  if (!chainId || !to || !value || !data) return [];
  const chain_id = Number(big(chainId));
  if (data.length === 0) {
    return [{ asset: { EvmNative: { chain_id } }, to: [...to], amount: big(value).toString() }];
  }
  if (data.length === 68 && TRANSFER.every((byte, i) => data[i] === byte)) {
    return [
      {
        asset: { Erc20: { chain_id, token: [...to] } },
        to: [...data.subarray(16, 36)],
        amount: big(data.subarray(36, 68)).toString(),
      },
    ];
  }
  return [];
}

/** The payments a propose_spend call asked for, or none when its arguments can't be read. */
export function requestedPayments(argsBase64: string): Payment[] {
  try {
    const args = JSON.parse(new TextDecoder().decode(base64.decode(argsBase64))) as {
      chain?: string;
      tx?: string;
    };
    if (!args.tx) return [];
    const tx = base64.decode(args.tx);
    if (args.chain === "Bitcoin") return bitcoinOutputs(tx);
    if (args.chain === "Evm") return evmPayments(tx);
    return [];
  } catch {
    return [];
  }
}

import { base64, hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { bitcoinOutputs, evmPayments, requestedPayments } from "./decode";
import { featured, formatUnits, humanAmount, rulesOf, ruleFor, shownPayments, tally } from "./story";
import type { Activity, Policy } from "./vault";

const ACME = [0, 20, ...hex.decode("fc5b5d20f3573a7e7e479f0e901f9f0efcc327fa")];
const ATTACKER = [0, 20, ...new Array<number>(20).fill(0xba)];

const policy: Policy = {
  caps: [{ asset: "Btc", per_tx: "500000", per_24h: "2000000", queue_at: "250000" }],
  payees: [{ chain: "Bitcoin", to: ACME, label: "Acme Hosting" }],
  btc_max_fee_rate: 50,
  btc_max_inputs: 3,
  evm_chain_ids: [84532],
  evm_max_gas_cost: "1000000000000000",
  veto_delay_ns: 120_000_000_000,
};

const entry = (event: string, extra: Partial<Activity> = {}): Activity => ({
  event,
  payments: [],
  txHash: event,
  at: 0,
  ...extra,
});

describe("formatUnits", () => {
  it("moves the decimal point with string arithmetic only", () => {
    expect(formatUnits("600000", 8)).toBe("0.006");
    expect(formatUnits("123456789012345678901", 18)).toBe("123.456789012345678901");
    expect(formatUnits("1000000", 6)).toBe("1");
    expect(formatUnits("0", 8)).toBe("0");
    expect(formatUnits("123456700000000", 8)).toBe("1,234,567");
  });

  it("names the unit, and falls back to base units for an unknown token", () => {
    expect(humanAmount("Btc", "250000")).toBe("0.0025 BTC");
    expect(humanAmount({ Erc20: { chain_id: 1, token: [1] } }, "5000")).toBe("5,000 base units");
  });
});

describe("rulesOf", () => {
  it("reads the policy as numbered sentences that end in a default refusal", () => {
    const rules = rulesOf(policy);
    expect(rules[0]?.text).toBe("Pay only listed payees: Acme Hosting");
    expect(rules.map((rule) => rule.text)).toContain("Refuse any single BTC payment over 0.005 BTC");
    expect(rules.at(-1)?.text).toBe("Refuse everything else");
    expect(rules.map((rule) => rule.id)).toEqual(rules.map((_, i) => `R${i + 1}`));
  });

  it("points each refusal at the rule it broke", () => {
    const rules = rulesOf(policy);
    expect(ruleFor(rules, "OutputNotWhitelisted")?.id).toBe("R1");
    expect(ruleFor(rules, "PerTxCapExceeded")?.text).toContain("single BTC payment");
    expect(ruleFor(rules, undefined)).toBeUndefined();
  });
});

describe("featured", () => {
  it("prefers the newest refusal that has a payment to show", () => {
    const attack = entry("spend_rejected", {
      txHash: "attack",
      requested: [{ asset: "Btc", to: ATTACKER, amount: "600000" }],
    });
    const log = [entry("spend_signed"), entry("spend_rejected", { txHash: "bare" }), attack];
    expect(featured(log)?.txHash).toBe("attack");
    expect(featured([entry("spend_signed")])?.event).toBe("spend_signed");
    expect(featured(null)).toBeUndefined();
  });

  it("shows the contract's payments over the decoded request", () => {
    const paid = [{ asset: "Btc" as const, to: ACME, amount: "1" }];
    expect(shownPayments(entry("spend_signed", { payments: paid }))).toEqual({ payments: paid, requested: false });
    expect(shownPayments(entry("spend_rejected", { requested: paid })).requested).toBe(true);
  });
});

describe("tally", () => {
  it("counts refusals, signatures, and signed payments to unlisted addresses", () => {
    const log = [
      entry("spend_rejected"),
      entry("spend_signed", { payments: [{ asset: "Btc", to: ACME, amount: "1" }] }),
      entry("spend_signed", { payments: [{ asset: "Btc", to: ATTACKER, amount: "1" }] }),
      entry("spend_proposed"),
    ];
    expect(tally(log, policy)).toEqual({ blocked: 1, signed: 2, signedOffList: 1, events: 3 });
  });
});

describe("decoding what the agent asked for", () => {
  // Version 2, one input, outputs to the attacker and back to the vault, locktime 0.
  const btcTx = Uint8Array.from([
    ...[2, 0, 0, 0],
    1,
    ...new Array<number>(36).fill(0),
    0,
    ...[0xfd, 0xff, 0xff, 0xff],
    2,
    ...[0xc0, 0x27, 0x09, 0, 0, 0, 0, 0],
    22,
    ...ATTACKER,
    ...[0x10, 0x27, 0, 0, 0, 0, 0, 0],
    22,
    ...ACME,
    ...[0, 0, 0, 0],
  ]);

  it("reads every output of a Bitcoin transaction with its integer amount", () => {
    expect(bitcoinOutputs(btcTx)).toEqual([
      { asset: "Btc", to: ATTACKER, amount: "600000" },
      { asset: "Btc", to: ACME, amount: "10000" },
    ]);
  });

  const rlpBytes = (bytes: number[]) =>
    bytes.length === 1 && (bytes[0] as number) < 0x80
      ? bytes
      : bytes.length <= 55
        ? [0x80 + bytes.length, ...bytes]
        : [0xb8, bytes.length, ...bytes];
  const rlpList = (items: number[][]) => {
    const body = items.flat();
    return body.length <= 55 ? [0xc0 + body.length, ...body] : [0xf8, body.length, ...body];
  };
  const token = new Array<number>(20).fill(0x03);
  const to = new Array<number>(20).fill(0xbd);
  const evmTx = (target: number[], value: number[], data: number[]) =>
    Uint8Array.from([
      2,
      ...rlpList([
        rlpBytes([0x01, 0x4a, 0x34]),
        rlpBytes([]),
        rlpBytes([1]),
        rlpBytes([2]),
        rlpBytes([0x52, 0x08]),
        rlpBytes(target),
        rlpBytes(value),
        rlpBytes(data),
        [0xc0],
      ]),
    ]);

  it("reads a native transfer and an ERC-20 transfer from an EIP-1559 transaction", () => {
    expect(evmPayments(evmTx(to, [0x03, 0xe8], []))).toEqual([
      { asset: { EvmNative: { chain_id: 84532 } }, to, amount: "1000" },
    ]);
    const transfer = [0xa9, 0x05, 0x9c, 0xbb, ...new Array<number>(12).fill(0), ...to, ...new Array<number>(31).fill(0), 0x2a];
    expect(evmPayments(evmTx(token, [], transfer))).toEqual([
      { asset: { Erc20: { chain_id: 84532, token } }, to, amount: "42" },
    ]);
  });

  it("decodes a propose_spend call, and gives up quietly on anything it can't read", () => {
    const args = base64.encode(
      new TextEncoder().encode(JSON.stringify({ chain: "Bitcoin", tx: base64.encode(btcTx) })),
    );
    expect(requestedPayments(args)[0]?.amount).toBe("600000");
    expect(requestedPayments("not base64!")).toEqual([]);
    expect(evmPayments(Uint8Array.from([1, 2, 3]))).toEqual([]);
  });
});

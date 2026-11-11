import { describe, expect, it } from "vitest";
import { buildPolicy, STARTING_FORM } from "./create";
import { describeChanges, formFromPolicy, policyFromForm } from "./policyEdit";
import type { Policy } from "./vault";

const ACME = { label: "Acme Hosting", chain: "Bitcoin" as const, address: "tb1ql3d46g8n2ua8ulj8nu8fq8ulpm7vxfl6tjfxgs" };
const SOL = { label: "Ada", chain: "Solana" as const, address: "xR99hjGSXQVvAWCPFfg8ZjqeLeWn9KVcX6X3N1iFHRU" };
const btcOf = (form: ReturnType<typeof formFromPolicy>) => {
  if (!form.caps.btc) throw new Error("no BTC cap");
  return form.caps.btc;
};
const live = (): Policy => buildPolicy({ ...STARTING_FORM, name: "v", payees: [ACME, SOL] });

describe("the policy form", () => {
  it("gives back the live policy when nothing is changed", () => {
    const policy = live();
    expect(policyFromForm(formFromPolicy(policy), policy)).toEqual(policy);
    expect(describeChanges(policy, policyFromForm(formFromPolicy(policy), policy))).toEqual([]);
  });

  it("shows a Solana payee once, and lists its USDC account again on save", () => {
    const form = formFromPolicy(live());
    expect(form.payees).toEqual([ACME, SOL]);
    expect(live().payees.map((p) => p.label)).toEqual(["Acme Hosting", "Ada", "Ada (USDC)"]);
  });

  it("keeps what it doesn't show: fee ceilings, swap settings and unknown assets", () => {
    const policy: Policy = {
      ...live(),
      btc_max_fee_rate: 7,
      caps: [...live().caps, { asset: { Erc20: { chain_id: 1, token: [1] } }, per_tx: "1", per_24h: "1", queue_at: "1", unlisted_per_24h: "0" }],
    };
    const saved = policyFromForm({ ...formFromPolicy(policy), vetoSeconds: "300" }, policy);
    expect(saved.btc_max_fee_rate).toBe(7);
    expect(saved.swap).toEqual(policy.swap);
    expect(saved.caps).toHaveLength(6);
    expect(saved.veto_delay_ns).toBe(300_000_000_000);
  });

  it("describes each change in words", () => {
    const policy = live();
    const form = formFromPolicy(policy);
    const next = policyFromForm(
      {
        ...form,
        payees: [...form.payees, { label: "Bob", chain: "Evm", address: "0x8a6d5c011a9a1480a89b20eb1482bbe89baef829" }],
        openPayees: false,
        caps: { ...form.caps, btc: { ...btcOf(form), perTx: "0.01" }, sol: null },
      },
      policy,
    );
    expect(describeChanges(policy, next)).toEqual([
      "Adds payee Bob (Base) 0x8a6d5c011a9a1480a89b20eb1482bbe89baef829",
      "New addresses: held → refused",
      "BTC, most per payment: 0.005 → 0.01",
      "BTC, new addresses, most per 24 hours: 0.004 → 0",
      "ETH on Base, new addresses, most per 24 hours: 0.01 → 0",
      "USDC on Base, new addresses, most per 24 hours: 40 → 0",
      "Stops paying in SOL",
      "USDC on Solana, new addresses, most per 24 hours: 40 → 0",
    ]);
  });

  it("refuses a bad address or limit before the wallet opens", () => {
    const policy = live();
    const form = formFromPolicy(policy);
    expect(() => policyFromForm({ ...form, payees: [{ ...ACME, address: "bc1qnotatestnetaddress" }] }, policy)).toThrow("testnet4");
    expect(() => policyFromForm({ ...form, caps: { ...form.caps, btc: { ...btcOf(form), queueAt: "1" } } }, policy)).toThrow("veto threshold");
    expect(() => policyFromForm({ ...form, unlistedSeconds: "10" }, policy)).toThrow("can't be shorter");
  });
});

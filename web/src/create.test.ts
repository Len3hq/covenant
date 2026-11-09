import { describe, expect, it } from "vitest";
import { buildPolicy, buildRequest, parseUnits, payeeBytes, STARTING_FORM, type VaultForm } from "./create";

const form: VaultForm = {
  ...STARTING_FORM,
  name: "acme",
  agent: "bot.testnet",
  payees: [{ label: "Host", chain: "Bitcoin", address: "tb1ql3d46g8n2ua8ulj8nu8fq8ulpm7vxfl6tjfxgs" }],
};

describe("parseUnits", () => {
  it("moves the decimal point without floats", () => {
    expect(parseUnits("0.005", 8)).toBe("500000");
    expect(parseUnits("1.5", 24)).toBe("1500000000000000000000000");
    expect(parseUnits("0.1", 18)).toBe("100000000000000000");
    expect(parseUnits("12", 6)).toBe("12000000");
    expect(parseUnits("0", 8)).toBe("0");
    expect(parseUnits("1.50", 1)).toBe("15");
  });

  it("refuses what isn't an amount, and precision the unit can't hold", () => {
    for (const bad of ["", "abc", "-1", "1e5", "1.2.3", ".5"]) {
      expect(() => parseUnits(bad, 8)).toThrow("isn't an amount");
    }
    expect(() => parseUnits("0.000000001", 8)).toThrow("decimal places");
  });
});

describe("payeeBytes", () => {
  it("gives the script the contract compares a Bitcoin payment with", () => {
    const bytes = payeeBytes("Bitcoin", "tb1ql3d46g8n2ua8ulj8nu8fq8ulpm7vxfl6tjfxgs");
    expect(bytes.slice(0, 2)).toEqual([0, 20]);
    expect(bytes).toHaveLength(22);
    expect(bytes[2]).toBe(0xfc);
  });

  it("refuses addresses the vault can't pay", () => {
    expect(() => payeeBytes("Bitcoin", "tb1qnotvalid")).toThrow("isn't a Bitcoin");
    // Mainnet, with a valid checksum.
    expect(() => payeeBytes("Bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toThrow("tb1q");
    expect(() => payeeBytes("Evm", "0x1234")).toThrow("isn't an EVM");
    expect(payeeBytes("Evm", `0x${"Ab".repeat(20)}`)).toHaveLength(20);
  });
});

describe("buildPolicy", () => {
  it("writes every limit in the asset's integer unit", () => {
    const policy = buildPolicy(form);
    expect(policy.caps[0]).toEqual({ asset: "Btc", per_tx: "500000", per_24h: "2000000", queue_at: "250000" });
    expect(policy.caps[2]?.per_tx).toBe("50000000");
    expect(policy.veto_delay_ns).toBe(120_000_000_000);
  });

  it("refuses limits the contract would refuse", () => {
    expect(() => buildPolicy({ ...form, btc: { ...form.btc, perTx: "0" } })).toThrow("above zero");
    expect(() => buildPolicy({ ...form, btc: { ...form.btc, queueAt: "1" } })).toThrow("veto threshold");
    expect(() => buildPolicy({ ...form, payees: [] })).toThrow("at least one payee");
    expect(() => buildPolicy({ ...form, vetoSeconds: "1.5" })).toThrow("whole number");
  });
});

describe("buildRequest", () => {
  it("attaches the deposit in yoctoNEAR and leaves a blank guardian out", () => {
    const { args, deposit } = buildRequest(form, "vaults.testnet", "me.testnet");
    expect(deposit).toBe("1500000000000000000000000");
    expect(args.guardian).toBeNull();
    expect(args.name).toBe("acme");
  });

  it("refuses an agent that shares a role, and a name NEAR would refuse", () => {
    expect(() => buildRequest({ ...form, agent: "me.testnet" }, "vaults.testnet", "me.testnet")).toThrow("own account");
    expect(() => buildRequest({ ...form, guardian: "bot.testnet" }, "vaults.testnet", "me.testnet")).toThrow("own account");
    expect(() => buildRequest({ ...form, name: "a.b" }, "vaults.testnet", "me.testnet")).toThrow("no dots");
    expect(() => buildRequest({ ...form, name: "a".repeat(60) }, "vaults.testnet", "me.testnet")).toThrow("too long");
  });
});

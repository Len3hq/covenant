import { describe, expect, it } from "vitest";
import { btcAddress, describeAsset, describePayee, loadVault } from "./vault";

const config = { rpcUrl: "https://rpc.example", accountId: "vault.testnet" };
const PUBKEY = "020377b2259fc3aab0f22b7f433de1695908c943a24e47028206c300da365b6ef7";

const views: Record<string, unknown> = {
  is_frozen: false,
  get_addresses: { btc_pubkey: PUBKEY, evm_address: "0xabc" },
  get_policy: { caps: [], payees: [] },
};

/** Answers like a NEAR RPC node: the return value is JSON, as an array of bytes. */
const rpc: typeof fetch = async (_url, init) => {
  const { params } = JSON.parse(String(init?.body)) as {
    params: { method_name: string; account_id: string };
  };
  expect(params.account_id).toBe("vault.testnet");
  const bytes = new TextEncoder().encode(JSON.stringify(views[params.method_name]));
  return new Response(JSON.stringify({ result: { result: [...bytes] } }));
};

describe("loadVault", () => {
  it("reads the frozen state, addresses and policy", async () => {
    await expect(loadVault(config, rpc)).resolves.toEqual({
      frozen: false,
      btcAddress: "tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9",
      evmAddress: "0xabc",
      policy: { caps: [], payees: [] },
    });
  });

  it("surfaces a contract error", async () => {
    const failing: typeof fetch = async () =>
      new Response(JSON.stringify({ result: { error: "MethodNotFound" } }));
    await expect(loadVault(config, failing)).rejects.toThrow("MethodNotFound");
  });

  it("surfaces an HTTP error", async () => {
    const failing: typeof fetch = async () => new Response("", { status: 503 });
    await expect(loadVault(config, failing)).rejects.toThrow("503");
  });
});

describe("formatting", () => {
  it("derives the vault's testnet4 address", () => {
    expect(btcAddress(PUBKEY)).toBe("tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9");
  });

  it("names each asset with its integer unit", () => {
    expect(describeAsset("Btc")).toEqual({ name: "BTC", unit: "sats" });
    expect(describeAsset({ EvmNative: { chain_id: 84532 } }).unit).toBe("wei");
    const usdc = describeAsset({ Erc20: { chain_id: 84532, token: [3, 108] } });
    expect(usdc.name).toBe("ERC-20 0x036c (chain 84532)");
    expect(usdc.unit).toBe("base units");
  });

  it("prefixes EVM payees only", () => {
    expect(describePayee({ chain: "Evm", to: [171], label: "a" })).toBe("a (Evm): 0xab");
    expect(describePayee({ chain: "Bitcoin", to: [171], label: "b" })).toBe("b (Bitcoin): ab");
  });
});

import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { btcAddress, describeAsset, describePayee, loadVault } from "./vault";

const config = {
  rpcUrl: "https://rpc.example",
  accountId: "vault.testnet",
  btcApiUrl: "https://btc.example",
  evmRpcUrl: "https://evm.example",
  evmChainId: 84532,
};
const USDC = hex.decode("036cbd53842c5426634e7929541ec2318f3dcf7e");
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
      balances: [],
    });
  });

  describe("balances", () => {
    const caps = [
      { asset: "Btc", per_tx: "1", per_24h: "2000000", queue_at: "1" },
      { asset: { EvmNative: { chain_id: 84532 } }, per_tx: "1", per_24h: "5", queue_at: "1" },
      { asset: { Erc20: { chain_id: 84532, token: [...USDC] } }, per_tx: "1", per_24h: "7", queue_at: "1" },
      { asset: { EvmNative: { chain_id: 1 } }, per_tx: "1", per_24h: "9", queue_at: "1" },
    ];

    function chains(btcStatus: number): typeof fetch {
      return async (url, init) => {
        if (url === "https://btc.example/address/tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9") {
          return new Response(
            JSON.stringify({
              chain_stats: { funded_txo_sum: 759051, spent_txo_sum: 500000 },
              mempool_stats: { funded_txo_sum: 479859, spent_txo_sum: 0 },
            }),
            { status: btcStatus },
          );
        }
        if (url === "https://evm.example") {
          const { method, params } = JSON.parse(String(init?.body)) as {
            method: string;
            params: [{ to: string; data: string }, string];
          };
          if (method === "eth_getBalance") {
            return new Response(JSON.stringify({ result: "0x5af3107a4000" }));
          }
          expect(params[0].to).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
          expect(params[0].data).toBe(`0x70a08231${"abc".padStart(64, "0")}`);
          return new Response(JSON.stringify({ result: "0x01312d00" }));
        }
        const { params } = JSON.parse(String(init?.body)) as {
          params: { method_name: string };
        };
        const values: Record<string, unknown> = {
          ...views,
          get_policy: { caps, payees: [] },
          get_spent_24h: "20141",
        };
        const bytes = new TextEncoder().encode(JSON.stringify(values[params.method_name]));
        return new Response(JSON.stringify({ result: { result: [...bytes] } }));
      };
    }

    it("reads each capped asset's balance as an exact integer", async () => {
      const { balances } = await loadVault(config, chains(200));
      expect(balances.map((b) => [b.name, b.balance, b.spent24h, b.per24h])).toEqual([
        ["BTC", "738910", "20141", "2000000"],
        ["ETH (chain 84532)", "100000000000000", "20141", "5"],
        ["USDC", "20000000", "20141", "7"],
        ["ETH (chain 1)", null, "20141", "9"],
      ]);
    });

    it("loses only the balance when a chain can't be read", async () => {
      const { balances } = await loadVault(config, chains(503));
      expect(balances[0]?.balance).toBeNull();
      expect(balances[0]?.spent24h).toBe("20141");
      expect(balances[1]?.balance).toBe("100000000000000");
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
    expect(describeAsset({ Erc20: { chain_id: 84532, token: [...USDC] } }).name).toBe("USDC");
  });

  it("prefixes EVM payees only", () => {
    expect(describePayee({ chain: "Evm", to: [171], label: "a" })).toBe("a (Evm): 0xab");
    expect(describePayee({ chain: "Bitcoin", to: [171], label: "b" })).toBe("b (Bitcoin): ab");
  });
});

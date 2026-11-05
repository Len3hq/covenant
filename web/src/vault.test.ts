import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  btcAddress,
  describeActivity,
  describeAsset,
  describePayee,
  loadActivity,
  loadVault,
  secondsUntil,
} from "./vault";

const config = {
  rpcUrl: "https://rpc.example",
  accountId: "vault.testnet",
  btcApiUrl: "https://btc.example",
  evmRpcUrl: "https://evm.example",
  evmChainId: 84532,
  txApiUrl: "https://tx.example",
};
const USDC = hex.decode("036cbd53842c5426634e7929541ec2318f3dcf7e");
const PUBKEY = "020377b2259fc3aab0f22b7f433de1695908c943a24e47028206c300da365b6ef7";

const views: Record<string, unknown> = {
  is_frozen: false,
  get_addresses: { btc_pubkey: PUBKEY, evm_address: "0xabc" },
  get_policy: { caps: [], payees: [] },
  get_queue: [],
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

describe("loadActivity", () => {
  const log = (event: string, data: unknown) =>
    `EVENT_JSON:${JSON.stringify({ standard: "covenant", version: "1.0.0", event, data })}`;

  function api(logs: Record<string, string[]>, times: Record<string, string>): typeof fetch {
    return async (url, init) => {
      if (String(url).endsWith("/v0/account")) {
        const account_txs = Object.entries(times).map(([transaction_hash, tx_block_timestamp]) => ({
          transaction_hash,
          tx_block_timestamp,
        }));
        return new Response(JSON.stringify({ account_txs }));
      }
      const { tx_hashes: hashes } = JSON.parse(String(init?.body)) as { tx_hashes: string[] };
      const transactions = hashes.map((hash) => ({
        transaction: { hash },
        receipts: (logs[hash] ?? []).map((line) => ({
          execution_outcome: { outcome: { logs: [line] } },
        })),
      }));
      return new Response(JSON.stringify({ transactions }));
    };
  }

  it("reads the vault's events, newest first, and ignores everything else", async () => {
    const fetcher = api(
      {
        old: [
          log("spend_rejected", [{ id: "1", chain: "Bitcoin", payments: [], fee: "0", error: "OutputNotWhitelisted" }]),
          "plain log line",
          'EVENT_JSON:{"standard":"nep141","event":"ft_transfer"}',
          "EVENT_JSON:{not json",
        ],
        recent: [log("frozen", [{ by: "owner.testnet" }])],
      },
      { old: "1000000000", recent: "2000000000" },
    );
    await expect(loadActivity(config, fetcher)).resolves.toEqual([
      { event: "frozen", by: "owner.testnet", payments: [], txHash: "recent", at: 2000 },
      {
        event: "spend_rejected",
        id: "1",
        chain: "Bitcoin",
        payments: [],
        fee: "0",
        error: "OutputNotWhitelisted",
        txHash: "old",
        at: 1000,
      },
    ]);
  });

  it("makes no second request for a vault with no transactions", async () => {
    await expect(loadActivity(config, api({}, {}))).resolves.toEqual([]);
  });
});

describe("describeActivity", () => {
  it("names the error on a refusal and marks it as stopped", () => {
    expect(
      describeActivity({ event: "spend_rejected", error: "FeeTooHigh", payments: [], txHash: "", at: 0 }),
    ).toEqual({ outcome: "Refused: FeeTooHigh", stopped: true });
  });
});

describe("secondsUntil", () => {
  it("counts down to a nanosecond timestamp and stops at zero", () => {
    expect(secondsUntil("90000000000", 30_000)).toBe(60);
    expect(secondsUntil("90000000000", 120_000)).toBe(0);
  });
});

describe("loadVault", () => {
  it("reads the frozen state, addresses and policy", async () => {
    await expect(loadVault(config, rpc)).resolves.toEqual({
      frozen: false,
      btcAddress: "tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9",
      evmAddress: "0xabc",
      policy: { caps: [], payees: [] },
      balances: [],
      queue: [],
      activity: null,
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

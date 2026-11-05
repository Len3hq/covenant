import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, Dashboard } from "./App";
import type { VaultState } from "./vault";

const vault: VaultState = {
  frozen: true,
  btcAddress: "tb1qddd2cgvedtlfgvgvx6f93rt9te77zsu9ccmcw9",
  evmAddress: "0xd913a8c28efdb2f30563e063b5fac5abd6ec9361",
  policy: {
    caps: [{ asset: "Btc", per_tx: "500000", per_24h: "2000000", queue_at: "250000" }],
    payees: [],
    btc_max_fee_rate: 50,
    btc_max_inputs: 3,
    evm_chain_ids: [84532],
    evm_max_gas_cost: "1000000000000000",
    veto_delay_ns: 120_000_000_000,
  },
  balances: [
    { name: "BTC", unit: "sats", balance: "738910", spent24h: "20141", per24h: "2000000" },
    { name: "USDC", unit: "base units", balance: null, spent24h: "0", per24h: "200000000" },
  ],
  queue: [],
  activity: [],
};

describe("App", () => {
  it("says it is reading the vault while it loads", () => {
    expect(renderToString(<App />)).toContain("Reading");
  });
});

describe("Dashboard", () => {
  it("shows the frozen state, addresses and policy from the contract", () => {
    const html = renderToString(
      <Dashboard accountId="v" status={{ kind: "ready", vault }} />,
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("Frozen");
    expect(html).toContain(vault.btcAddress);
    expect(html).toContain(vault.evmAddress);
    expect(html).toContain("500000");
    expect(html).toContain("sats");
    expect(html).toContain("120 s");
    expect(html).toContain("every payment is refused");
  });

  it("shows a queued spend with its wait and how to stop it", () => {
    const executableAt = String((BigInt(Date.now()) + 90_000n) * 1_000_000n);
    const queued: VaultState = {
      ...vault,
      queue: [
        {
          id: "7",
          chain: "Bitcoin",
          payments: [{ asset: "Btc", to: [1, 2], amount: "250000" }],
          fee: "141",
          queued_at: "0",
          executable_at: executableAt,
        },
      ],
    };
    const html = renderToString(
      <Dashboard accountId="v" status={{ kind: "ready", vault: queued }} />,
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("250000 sats of BTC to 0102");
    expect(html).toMatch(/(89|90) s/);
    expect(html).toContain("make veto");
  });

  it("marks refused spends in the log and links each to NEAR", () => {
    const logged: VaultState = {
      ...vault,
      activity: [
        { event: "spend_rejected", error: "OutputNotWhitelisted", chain: "Bitcoin", payments: [], txHash: "2ZKGhLm1abc", at: 0 },
        { event: "spend_signed", chain: "Evm", payments: [], txHash: "GpZoGLLmabc", at: 0 },
      ],
    };
    const html = renderToString(
      <Dashboard accountId="v" status={{ kind: "ready", vault: logged }} />,
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("Refused: OutputNotWhitelisted");
    expect(html).toContain("Signed");
    expect(html).toContain('class="stopped"');
    expect(html).toContain("https://testnet.nearblocks.io/txns/2ZKGhLm1abc");
  });

  it("says when the activity log can't be read", () => {
    const html = renderToString(
      <Dashboard accountId="v" status={{ kind: "ready", vault: { ...vault, activity: null } }} />,
    );
    expect(html).toContain("Unavailable");
  });

  it("shows balances and spend, and says when a chain can't be read", () => {
    const html = renderToString(<Dashboard accountId="v" status={{ kind: "ready", vault }} />);
    expect(html).toContain("Balances");
    expect(html).toContain("738910");
    expect(html).toContain("20141");
    expect(html).toContain("Unavailable");
  });

  it("shows a read failure instead of pretending to be connected", () => {
    const html = renderToString(
      <Dashboard accountId="v" status={{ kind: "error", message: "RPC down" }} />,
    );
    expect(html).toContain("RPC down");
    expect(html).not.toContain("Connected");
  });
});

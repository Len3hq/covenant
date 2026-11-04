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
};

describe("App", () => {
  it("renders every panel still to come while it loads", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Reading");
    for (const title of ["Queue", "Activity log"]) {
      expect(html).toContain(title);
    }
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

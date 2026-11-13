import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, Dashboard, type Controls } from "./App";
import type { VaultState } from "./vault";
import type { Role } from "./wallet";

const vault: VaultState = {
  roles: { owner: "owner.testnet", guardian: "dao.testnet", agent: "agent.testnet" },
  guardianDao: { accountId: "dao.testnet", council: ["member.testnet"], proposalBond: "1", nextProposalId: 4 },
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
  nearBalance: "3994411528526909700000000",
  agentAllowance: "971854810593997600000000",
};

describe("App", () => {
  it("opens on the landing page, with the way to create a vault and the demo", () => {
    const html = renderToString(<App />);
    expect(html).toContain("The vault can");
    expect(html).toContain('href="?create"');
    expect(html).toContain("See the live demo vault");
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
    expect(html).toContain("Refuse any single BTC payment over 0.005 BTC");
    expect(html).toContain("0.02 BTC");
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
    expect(html).toContain("0.0025 BTC");
    expect(html).toContain("0102");
    expect(html).toMatch(/1:(29|30) left/);
    expect(html).toContain("This goes through unless you veto it.");
    expect(html).toContain("no approve button");
    expect(html).toContain("can veto any of these");
  });

  it("says a held payment whose wait is over can be sent at any moment", () => {
    const due: VaultState = {
      ...vault,
      queue: [{ id: "8", chain: "Bitcoin", payments: [], fee: "141", queued_at: "0", executable_at: "1" }],
    };
    const html = renderToString(<Dashboard accountId="v" status={{ kind: "ready", vault: due }} />).replaceAll("<!-- -->", "");
    expect(html).toContain("Window over");
    expect(html).toContain("The wait is over: the agent is sending this now.");
  });

  it("marks refused spends in the log and links each to NEAR", () => {
    const logged: VaultState = {
      ...vault,
      activity: [
        { event: "spend_rejected", error: "OutputNotWhitelisted", chain: "Bitcoin", payments: [], txHash: "2ZKGhLm1abc", at: 0 },
        { event: "spend_signed", chain: "Evm", payments: [], txHash: "GpZoGLLmabc", at: 0 },
        { event: "spend_proposed", chain: "Evm", payments: [], txHash: "GpZoGLLmabc", at: 0 },
      ],
    };
    const html = renderToString(
      <Dashboard accountId="v" status={{ kind: "ready", vault: logged }} />,
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("Refused, because it paid an address that isn&#x27;t on the payee list");
    expect(html).toContain("OutputNotWhitelisted");
    expect(html).toContain("Signed");
    expect(html).toContain('class="row row-blocked"');
    expect(html).toContain('class="row row-signed"');
    expect(html).toContain("https://testnet.nearblocks.io/txns/2ZKGhLm1abc");
    expect(html).not.toContain("spend_proposed");
  });

  describe("controls", () => {
    const controls = (role: Role, account: string | null = "someone.testnet"): Controls => ({
      account,
      role,
      message: null,
      connect: () => undefined,
      disconnect: () => undefined,
      act: () => undefined,
    });
    const queued: VaultState = {
      ...vault,
      frozen: false,
      queue: [
        {
          id: "7",
          chain: "Bitcoin",
          payments: [],
          fee: "141",
          queued_at: "0",
          executable_at: "0",
        },
      ],
    };
    const render = (state: VaultState, role: Role, account?: string | null) =>
      renderToString(
        <Dashboard
          accountId="v"
          status={{ kind: "ready", vault: state }}
          controls={controls(role, account)}
        />,
      );

    it("offers Create agent key only to the agent account, and lists its vault keys", () => {
      const keyed: VaultState = {
        ...queued,
        agentKeys: [
          { publicKey: "ed25519:AAAAAAAAAAAAAAAAAAAAAAAA", full: false, forVault: true, allowance: "900000000000000000000000" },
        ],
      };
      const asAgent = render(keyed, "none", "agent.testnet").replaceAll("<!-- -->", "");
      expect(asAgent).toContain("Create agent key</button>");
      expect(asAgent).toContain("1 key that can only ask this vault");
      expect(asAgent).toContain("It has no full-access key.");
      expect(asAgent).not.toContain("Remove</button>");
      const asOwner = render(keyed, "owner", "owner.testnet").replaceAll("<!-- -->", "");
      expect(asOwner).not.toContain("Create agent key</button>");
      expect(asOwner).toContain("agent.testnet has no key a wallet holds");
    });

    it("lets an agent with a full-access key remove its vault keys", () => {
      const keyed: VaultState = {
        ...queued,
        agentKeys: [
          { publicKey: "ed25519:FULLFULLFULLFULLFULLFULL", full: true, forVault: false, allowance: null },
          { publicKey: "ed25519:AAAAAAAAAAAAAAAAAAAAAAAA", full: false, forVault: true, allowance: null },
        ],
      };
      const controls: Controls = {
        account: "agent.testnet",
        role: "none",
        message: null,
        connect: () => undefined,
        disconnect: () => undefined,
        act: () => undefined,
        removeAgentKey: () => undefined,
      };
      const html = renderToString(<Dashboard accountId="v" status={{ kind: "ready", vault: keyed }} controls={controls} />);
      expect(html).toContain("Remove</button>");
    });

    it("offers only a wallet connection to a visitor", () => {
      const html = render(queued, "none", null);
      expect(html).toContain("Connect wallet");
      expect(html).not.toContain("Veto</button>");
      expect(html).not.toContain("Freeze all chains");
      expect(html).not.toContain("Change the rules");
    });

    it("offers veto and freeze but not unfreeze or policy to a council member", () => {
      const html = render(queued, "council");
      expect(html).toContain("Veto</button>");
      expect(html).toContain("Freeze all chains");
      expect(html).not.toContain("Change the rules");
      expect(render({ ...queued, frozen: true }, "council")).not.toContain("Unfreeze</button>");
    });

    it("offers the owner policy editing and unfreeze", () => {
      expect(render(queued, "owner")).toContain("Change the rules");
      expect(render({ ...queued, frozen: true }, "owner")).toContain("Unfreeze</button>");
    });
  });

  it("shows the vault's NEAR and the agent's allowance, and warns when either runs low", () => {
    const fine = renderToString(<Dashboard accountId="v" status={{ kind: "ready", vault }} />).replaceAll("<!-- -->", "");
    expect(fine).toContain("3.99 NEAR");
    expect(fine).toContain("0.97 NEAR");
    expect(fine).not.toContain("Needs attention");
    const low = renderToString(
      <Dashboard
        accountId="v"
        status={{ kind: "ready", vault: { ...vault, agentAllowance: "250000000000000000000000" } }}
      />,
    );
    expect(low).toContain("Needs attention");
    expect(low).toContain("replace the key");
  });

  it("offers a chain filter on the activity log", () => {
    const html = renderToString(<Dashboard accountId="v" status={{ kind: "ready", vault }} />);
    expect(html).toContain("Bitcoin</button>");
    expect(html).toContain("Base</button>");
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
    expect(html).toContain("0.0073891 BTC");
    expect(html).toContain("0.00020141 BTC");
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

describe("the shared dashboard", () => {
  const ready = { kind: "ready", vault } as const;

  it("says a factory vault can't be changed", () => {
    const html = renderToString(
      <Dashboard accountId="v" status={ready} provenance={{ standard: true, keys: 0 }} />,
    );
    expect(html).toContain("Standard vault");
    expect(html).toContain("Nobody can change");
  });

  it("warns about any other vault, and names its keys", () => {
    const html = renderToString(
      <Dashboard accountId="v" status={ready} provenance={{ standard: false, keys: 2 }} />,
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("Not a standard vault");
    expect(html).toContain("2 access keys");
    expect(html).not.toContain("Nobody can change");
  });

  it("offers a way to open any vault and to create one", () => {
    const html = renderToString(<Dashboard accountId="v" status={ready} />);
    expect(html).toContain('name="vault"');
    expect(html).toContain('href="?create"');
  });

  it("shows the vault it was asked for, not ours", () => {
    const html = renderToString(<Dashboard accountId="acme.vaults.testnet" status={ready} />);
    expect(html).toContain("acme.vaults.testnet");
    expect(html).not.toContain("covenant.len3hq.testnet");
  });
});

describe("the docs", () => {
  it("links to the docs from every page", () => {
    expect(renderToString(<Dashboard accountId="v" status={{ kind: "ready", vault }} />)).toContain('href="?docs"');
  });

  it("splits the vault into tabs, with every section still on the page", () => {
    const html = renderToString(<Dashboard accountId="v.vaults-v3.len3hq.testnet" status={{ kind: "ready", vault }} />);
    for (const tab of ["Overview", "Activity", "Rules", "Agent", "Fund"]) expect(html).toContain(`>${tab}<`);
    expect(html).toContain("How every payment is checked");
    expect(html).toContain("Where to get test coins");
    expect(html).toContain("The vault&#x27;s addresses");
  });
});

describe("the veto queue's header", () => {
  it("gives each wait, not only the one for large payments", () => {
    const open: VaultState = { ...vault, policy: { ...vault.policy, unlisted: "Hold", unlisted_veto_delay_ns: 600_000_000_000 } };
    const html = renderToString(<Dashboard accountId="v" status={{ kind: "ready", vault: open }} />).replaceAll("<!-- -->", "");
    expect(html).toContain("Waits: 2 minutes for large payments, 10 minutes for new addresses");
  });
});

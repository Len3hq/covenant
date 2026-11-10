import { claudeCodeCommand, desktopConfig, installSteps, MCP_PUBLISHED } from "./mcpConfig";
import { FACTORY_ID, REFUSALS } from "./vault";

const SDK_EXAMPLE = `import { Covenant } from "@len3hq/covenant-sdk";

const wallet = Covenant.connect({
  vault: "acme.${FACTORY_ID}",
  agentAccount: "my-agent.testnet",
  agentKey: process.env.AGENT_PRIVATE_KEY!, // the restricted key, never a full-access one
  solNonceAccounts: ["<from make sol-nonce>"], // only for Solana payments
});

const result = await wallet.pay({
  asset: "BTC",
  to: "Acme Hosting",     // a payee's name from the policy, or an address
  amount: 20_000n,        // whole base units: sats here
  reference: "INV-1042",  // the same reference never pays twice
});

if (result.status === "rejected") {
  console.log("Refused by the vault:", result.error); // e.g. OutputNotWhitelisted
}`;

const PLACEHOLDERS = { vault: `acme.${FACTORY_ID}`, agent: "my-agent.testnet", key: "ed25519:…" };
const INSTALL = installSteps();
const MCP_DESKTOP = desktopConfig(PLACEHOLDERS);
const MCP_CODE = claudeCodeCommand(PLACEHOLDERS);

const AGENT_KEY = `VAULT_ACCOUNT_ID=acme.${FACTORY_ID} AGENT_ACCOUNT_ID=my-agent.testnet make agent-key`;

const SECTIONS = [
  ["how", "How it works"],
  ["start", "Quick start"],
  ["sdk", "TypeScript SDK"],
  ["mcp", "MCP server"],
  ["outcomes", "Outcomes and errors"],
  ["security", "What it guarantees"],
  ["contract", "Contract reference"],
] as const;

function Code({ children }: { children: string }) {
  return <pre className="code mono">{children}</pre>;
}

export function Docs() {
  return (
    <div className="docs">
      <nav className="docs-nav" aria-label="Docs sections">
        <p className="label">Docs</p>
        {SECTIONS.map(([id, title]) => (
          <a key={id} href={`#${id}`}>
            {title}
          </a>
        ))}
      </nav>
      <article className="docs-body">
        <p className="eyebrow">Covenant docs · testnet · unaudited</p>
        <h1>Give your agent a wallet it can't be talked out of.</h1>
        <p className="lede">
          Your agent asks for payments. A Covenant vault, a contract on NEAR, checks each one against rules you set,
          and only then does NEAR's MPC network sign it on Bitcoin, Base or Solana. A fooled or hijacked agent can ask for
          anything, but it can't get a signature for a payment the rules forbid.
        </p>

        <section id="how">
          <h2>How it works</h2>
          <ol>
            <li>
              <strong>The agent proposes.</strong> It builds an unsigned Bitcoin, EVM or Solana transaction and calls{" "}
              <code>propose_spend</code> with a key that can call nothing else.
            </li>
            <li>
              <strong>The vault checks.</strong> It parses the raw transaction itself, works out where the money really
              goes, and checks payees, per-payment and 24-hour caps, fees and the chain. It computes the hash to sign;
              it never accepts one.
            </li>
            <li>
              <strong>Large payments wait.</strong> Above your threshold, a payment waits out a veto window. You, or a
              guardian such as a Sputnik DAO, can veto it or freeze every chain.
            </li>
            <li>
              <strong>NEAR's MPC network signs</strong> only what the vault approved. The agent, or anyone, broadcasts
              it.
            </li>
          </ol>
          <p>There's no AI in the security path. The checks are ordinary contract code.</p>
        </section>

        <section id="start">
          <h2>Quick start</h2>
          <ol className="steps">
            <li>
              <strong>Create a vault.</strong> On the <a href="?create">create page</a>, connect a NEAR testnet
              wallet, name your agent's account, and set payees and limits. You own the vault; its code can't be
              changed by anyone, including us.
            </li>
            <li>
              <strong>Fund it.</strong> Open your vault's dashboard for its Bitcoin testnet4, Base Sepolia and Solana devnet addresses,
              and send testnet funds to them.
            </li>
            <li>
              <strong>Give the agent a restricted key.</strong> It can call only <code>propose_spend</code> and{" "}
              <code>execute</code> on your vault, with 1 NEAR of gas allowance. From a clone of the repo, with the agent
              account's full key in your NEAR CLI keychain:
              <Code>{AGENT_KEY}</Code>
              It writes the new key to <code>.env</code> and never prints it.
            </li>
            <li>
              <strong>Connect your agent</strong> with the <a href="#sdk">SDK</a> if you write code, or the{" "}
              <a href="#mcp">MCP server</a> for Claude, Cursor or any MCP client.
            </li>
          </ol>
        </section>

        <section id="sdk">
          <h2>TypeScript SDK</h2>
          <p>
            <code>@len3hq/covenant-sdk</code> builds the transactions, proposes them, broadcasts what the vault signs, and
            records every step before taking it, so a crash or retry never pays twice.{" "}
            {MCP_PUBLISHED ? "Install it from npm:" : "It isn't on npm yet; build it from the repo:"}
          </p>
          <Code>{INSTALL}</Code>
          <Code>{SDK_EXAMPLE}</Code>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>pay({"{ asset, to, amount, reference }"})</code></td>
                <td>Asks the vault to pay. <code>asset</code> is <code>BTC</code>, <code>ETH</code>, <code>USDC</code> (on Base), <code>SOL</code> or{" "}
                  <code>USDC-SOL</code>, and <code>amount</code> is a bigint in base units.</td>
              </tr>
              <tr>
                <td><code>execute(id)</code></td>
                <td>Signs and broadcasts a queued payment once its veto window has passed. The vault checks it again.</td>
              </tr>
              <tr>
                <td><code>payees()</code></td>
                <td>Who the vault may pay, with names and addresses.</td>
              </tr>
              <tr>
                <td><code>balances()</code></td>
                <td>What each asset holds and has spent in the last 24 hours.</td>
              </tr>
              <tr>
                <td><code>queue()</code></td>
                <td>Payments waiting out the veto window.</td>
              </tr>
              <tr>
                <td><code>addresses()</code></td>
                <td>The vault's Bitcoin, Base and Solana addresses.</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">
            Amounts are always integers: sats, wei, lamports, and USDC's 6 decimals, so 1 USDC is <code>1_000_000n</code>. Keep{" "}
            <code>spendsFile</code> on storage that survives restarts.
          </p>
        </section>

        <section id="mcp">
          <h2>MCP server</h2>
          <p>
            Gives any MCP client nine tools: <code>pay</code>, <code>quote_payment</code>,{" "}
            <code>list_destinations</code>, <code>get_payment_status</code>, <code>list_payees</code>,{" "}
            <code>get_balances</code>, <code>get_addresses</code>, <code>list_queue</code> and{" "}
            <code>execute_queued</code>.{" "}
            {MCP_PUBLISHED ? (
              <>Your app starts it with npx, so there's nothing to install.</>
            ) : (
              <>
                Build it as in the <a href="#sdk">SDK section</a>, then add it to your client.
              </>
            )}{" "}
            It records payments in <code>~/.covenant/</code>, so none is paid twice; set <code>SPENDS_FILE</code> to
            keep them elsewhere. For Solana, add <code>SOL_NONCE_ACCOUNTS</code> from <code>make sol-nonce</code>.
          </p>
          <p><strong>Claude Code</strong></p>
          <Code>{MCP_CODE}</Code>
          <p>
            <strong>Claude Desktop</strong>, in <code>claude_desktop_config.json</code>, or <strong>Cursor</strong>, in{" "}
            <code>~/.cursor/mcp.json</code>:
          </p>
          <Code>{MCP_DESKTOP}</Code>
          <p className="muted small">
            The key in this config can only ask your vault for payments. If it leaks, the worst it can do is propose
            payments your policy allows and spend its 1 NEAR of gas. Still, keep the file private.
          </p>
        </section>

        <section id="outcomes">
          <h2>Outcomes and errors</h2>
          <table>
            <tbody>
              <tr>
                <td><code>broadcast</code></td>
                <td>The vault agreed, the MPC network signed, and the payment was sent. <code>links.chain</code> points at it.</td>
              </tr>
              <tr>
                <td><code>queued</code></td>
                <td>At or above your veto threshold. Call <code>execute(id)</code> after <code>executableAt</code>.</td>
              </tr>
              <tr>
                <td><code>rejected</code></td>
                <td>The vault refused it, and <code>error</code> names the rule. Nothing was signed. Don't retry it another way.</td>
              </tr>
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Error</th>
                <th>Refused because</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(REFUSALS).map(([name, reason]) => (
                <tr key={name}>
                  <td><code>{name}</code></td>
                  <td>{reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section id="security">
          <h2>What it guarantees</h2>
          <ul>
            <li><strong>Only listed payees get paid</strong>, plus Bitcoin change back to the vault.</li>
            <li><strong>Caps hold</strong> per payment and per rolling 24 hours, including fees and across concurrent payments.</li>
            <li><strong>Large payments wait</strong> for a veto window, and are checked again against the rules in force when they execute.</li>
            <li><strong>The agent can't change the rules.</strong> Its key can't set policy, veto, freeze or move NEAR.</li>
            <li><strong>Vaults made by the factory can't be changed</strong> by anyone: they have no keys and run shared, published code.</li>
          </ul>
          <p>What a hijacked agent can still do: pay listed payees up to the caps, fill the veto queue, and spend its key's gas allowance.</p>
          <p className="muted small">
            Testnet only, and not audited. Each claim maps to a named test in the repo's SECURITY.md.
          </p>
        </section>

        <section id="contract">
          <h2>Contract reference</h2>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Who</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              <tr><td><code>propose_spend</code></td><td>Agent</td><td>Parse, check, then sign, queue or refuse a payment</td></tr>
              <tr><td><code>execute</code></td><td>Agent</td><td>Sign a queued payment after its window, re-checking the policy</td></tr>
              <tr><td><code>veto</code></td><td>Owner, guardian</td><td>Remove a queued payment</td></tr>
              <tr><td><code>freeze</code> / <code>unfreeze</code></td><td>Owner and guardian / owner</td><td>Stop or restart all signing</td></tr>
              <tr><td><code>set_policy</code></td><td>Owner</td><td>Change payees and limits</td></tr>
              <tr><td><code>get_policy</code>, <code>get_queue</code>, <code>get_roles</code>, <code>get_addresses</code></td><td>Anyone</td><td>Read the vault</td></tr>
            </tbody>
          </table>
          <p className="muted small">
            Vaults are created by <code>{FACTORY_ID}</code> with <code>create_vault</code>. Every vault emits NEP-297
            events, which this dashboard reads.
          </p>
        </section>
      </article>
    </div>
  );
}

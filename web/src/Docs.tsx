import { HOSTED_TABS, hostedSnippetFor } from "./HostedConnect";
import { CONNECTOR_URL, connectorMcpUrl } from "./hosted";
import { claudeCodeCommand, desktopConfig, installSteps, MCP_PUBLISHED, vscodeConfig } from "./mcpConfig";
import { FACTORY_ID, REFUSALS } from "./vault";

const SDK_EXAMPLE = `import { Covenant } from "@len3hq/covenant-sdk";

const wallet = Covenant.connect({
  vault: "acme.${FACTORY_ID}",
  agentAccount: "agent.you.testnet",
  agentKey: process.env.AGENT_PRIVATE_KEY!, // the restricted key, never a full-access one
  solNonceAccounts: ["<from covenant-mcp sol-nonce>"], // only for Solana payments
});

const result = await wallet.pay({
  asset: "BTC",
  to: "Acme Hosting",     // a payee's name from the policy, or an address
  amount: 20_000n,        // whole base units: sats here
  reference: "INV-1042",  // the same reference never pays twice
});

if (result.status === "rejected") {
  console.log("Refused by the vault:", result.error); // e.g. PerTxCapExceeded
}`;

const SDK_SIGNER = `import { Covenant, type RemoteSigner } from "@len3hq/covenant-sdk";

// The key lives elsewhere (an enclave, an HSM). It signs one vault call at a time,
// rebuilt from its fields; the SDK checks the signature before it broadcasts.
const signer: RemoteSigner = {
  publicKey: "ed25519:…",
  sign: async (call) => mySigningService.sign(call),
};

const wallet = Covenant.connect({ vault, agentAccount, signer });`;

const PLACEHOLDERS = { vault: `acme.${FACTORY_ID}`, agent: "agent.you.testnet", key: "ed25519:…" };
const INSTALL = installSteps();
const MCP_DESKTOP = desktopConfig(PLACEHOLDERS);
const MCP_CODE = claudeCodeCommand(PLACEHOLDERS);
const MCP_VSCODE = vscodeConfig(PLACEHOLDERS);
const HOSTED_URL = CONNECTOR_URL ? connectorMcpUrl(CONNECTOR_URL, "<vault>") : "https://<the hosted connector>/v/<vault>/mcp";

const ENV_FILE = `cp .env.example .env.acme   # then set VAULT_ACCOUNT_ID and AGENT_ACCOUNT_ID in it`;
const AGENT_KEY = `make agent-key ENV_FILE=.env.acme`;
const SOL_NONCE = `make sol-nonce ENV_FILE=.env.acme`;

const SECTIONS = [
  ["how", "How it works"],
  ["start", "Quick start"],
  ["create", "Creating a vault"],
  ["manage", "Managing a vault"],
  ["hosted", "Hosted agents"],
  ["apps", "Add to an AI app"],
  ["mcp", "MCP server, run yourself"],
  ["sdk", "TypeScript SDK"],
  ["outcomes", "Outcomes and errors"],
  ["security", "What it guarantees"],
  ["contract", "Contract reference"],
  ["help", "Troubleshooting"],
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
          Your agent asks for payments. A Covenant vault, a contract on NEAR, checks each one against rules you set, and
          only then does NEAR's MPC network sign it on Bitcoin, Base or Solana. A fooled or hijacked agent can ask for
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
              goes, and checks payees, per-payment and 24-hour limits, fees and the chain. It computes the hash to sign;
              it never accepts one.
            </li>
            <li>
              <strong>Some payments wait.</strong> Large ones, and every payment to an address that isn't a payee, wait
              out a veto window first. You, or a guardian such as a Sputnik DAO, can veto any of them or freeze every
              chain.
            </li>
            <li>
              <strong>NEAR's MPC network signs</strong> only what the vault approved. The agent, or anyone, broadcasts it.
            </li>
          </ol>
          <p>There's no AI in the security path. The checks are ordinary contract code nobody can change.</p>
        </section>

        <section id="start">
          <h2>Quick start</h2>
          <ol className="steps">
            <li>
              <strong>Connect a NEAR testnet wallet</strong> with the button at the top right. Any testnet account
              works; Meteor and Intear are the easiest.
            </li>
            <li>
              <strong>Create a vault</strong> with the <a href="?create">five-step wizard</a>. It takes about two minutes
              and costs a 1.1 NEAR deposit or more, plus 0.5 NEAR if the dashboard makes the agent's account.
            </li>
            <li>
              <strong>Fund it</strong> from the vault's <em>Fund</em> tab: each address has a copy button and a faucet
              link. Everything is free testnet money.
            </li>
            <li>
              <strong>Connect your agent:</strong> add a <a href="#hosted">hosted vault</a> to Claude, ChatGPT or any AI
              app by URL, run the <a href="#mcp">MCP server</a> yourself, or use the <a href="#sdk">SDK</a> in your own
              code.
            </li>
          </ol>
          <p>
            All your vaults are under <a href="?mine">My vaults</a>, once your wallet is connected. To open any other
            vault, such as one where you're the guardian, type its name in the search box at the top.
          </p>
        </section>

        <section id="create">
          <h2>Creating a vault</h2>
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>What you decide</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1. Name</td>
                <td>
                  The vault's name, which becomes <code>name.{FACTORY_ID}</code>. The page says whether it's free as you
                  type. Then the deposit, at least 1.1 NEAR, which stays in the vault for storage and signing fees.
                </td>
              </tr>
              <tr>
                <td>2. Agent</td>
                <td>
                  <strong>I'll run it</strong>: the dashboard creates <code>agent.you.testnet</code> and shows its key once,
                  with ready-made settings for Claude Desktop, Claude Code, Cursor and your own code.{" "}
                  <strong>Hosted</strong>: the key is made inside an enclave and never leaves it; you add the vault to an
                  AI app by URL (see <a href="#hosted">Hosted agents</a>). <strong>An account I have</strong>: use a NEAR
                  account you control, and add its vault key afterwards. Optionally, a guardian who can also veto and
                  freeze.
                </td>
              </tr>
              <tr>
                <td>3. Payments</td>
                <td>
                  <strong>Anyone, with a wait</strong>: payees are paid at once, anyone else only after the new-address
                  wait. <strong>Only my payees</strong>: everyone else is refused. Add payees by name, chain and address,
                  and choose whether it may pay on other chains through Tidepool's swaps.
                </td>
              </tr>
              <tr>
                <td>4. Limits</td>
                <td>
                  A preset (<em>Starter</em> or <em>Standard</em>) or every limit yourself, per asset in whole coins: most
                  per payment, most per 24 hours, the amount from which payments wait for a veto, and how much new
                  addresses may get per day. Then the two waits, in seconds.
                </td>
              </tr>
              <tr>
                <td>5. Review</td>
                <td>
                  A summary and the cost. Press <strong>Create vault</strong>. When the dashboard makes the agent's account,
                  your wallet signs twice: first the account, then <strong>Sign 2 of 2</strong> for the vault.
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            For a vault you run from a terminal, keep its settings in a file of its own, so two vaults never share keys or
            nonce accounts:
          </p>
          <Code>{ENV_FILE}</Code>
          <p>
            Then, for an agent account you already have, add its restricted key (it needs the account's full key in your
            NEAR CLI keychain, and writes the new key to the file without printing it), and for Solana, a durable nonce
            account the vault controls:
          </p>
          <Code>{`${AGENT_KEY}\n${SOL_NONCE}`}</Code>
        </section>

        <section id="manage">
          <h2>Managing a vault</h2>
          <p>A vault's page has five tabs. Anyone can read them; only the owner and guardian can act.</p>
          <table>
            <tbody>
              <tr>
                <td>Overview</td>
                <td>
                  Payments waiting for your decision, balances with today's spending against each limit, the latest
                  decision, and how every payment is checked.
                </td>
              </tr>
              <tr>
                <td>Activity</td>
                <td>
                  The veto queue, with a countdown and a <strong>Veto</strong> button for each held payment, and the
                  decision log: every payment signed, held, vetoed or refused, with the rule that decided it.
                </td>
              </tr>
              <tr>
                <td>Rules</td>
                <td>
                  Who it can pay, the limits per asset, and the waits. The owner changes them under{" "}
                  <strong>Change the rules</strong>: edit payees and limits in a form, press <strong>Review changes</strong>{" "}
                  to see each change in words, then save with your wallet. Settings the form doesn't show are kept as they
                  are; the JSON is under Advanced.
                </td>
              </tr>
              <tr>
                <td>Agent</td>
                <td>
                  The agent's keys and who can do what. The owner can <strong>Replace agent</strong> (a new agent account,
                  then <strong>Sign 2 of 2</strong> to switch the vault to it), for instance if a key leaks. Connected as
                  the agent account itself, you can <strong>Create agent key</strong> or <strong>Remove</strong> one.
                </td>
              </tr>
              <tr>
                <td>Fund</td>
                <td>Each address with a copy button, and a faucet for every coin the vault uses.</td>
              </tr>
            </tbody>
          </table>
          <p>
            <strong>Veto</strong> cancels one held payment for good: nothing is signed and its amount returns to the
            budgets. <strong>Freeze</strong>, at the top of the page, stops every payment on every chain until the owner
            unfreezes. A guardian DAO's council member proposes and votes, so their wallet signs twice.
          </p>
        </section>

        <section id="hosted">
          <h2>Hosted agents</h2>
          <p>
            A hosted agent's key is made inside an Intel TDX enclave run by OutLayer, and only its public key ever leaves
            it. Nobody can read the key, including us. You add the vault to an AI app by URL, and it works on the web and
            on your phone, with nothing to install.
          </p>
          <ol>
            <li>
              Create a vault with <strong>Hosted</strong> as the agent. The agent's account gets the enclave's key, limited
              to that vault.
            </li>
            <li>
              Add the vault's own address, <code>{HOSTED_URL}</code> with your vault's name, to your AI app (see{" "}
              <a href="#apps">Add to an AI app</a>). The vault's page shows it ready to copy, under Agent. Each hosted
              vault has its own address, so one app can hold several vaults as separate connectors.
            </li>
            <li>
              The app sends you to this dashboard. Pick the vault, choose how long, and press{" "}
              <strong>Sign and connect</strong>. Your wallet signs a <em>grant</em>: a message, not a transaction, naming
              the owner, vault, agent and expiry. It costs nothing and moves no funds.
            </li>
            <li>
              From then on, every payment the app asks for is signed by the enclave, which first checks your grant against
              NEAR, and the vault still applies every rule.
            </li>
          </ol>
          <p>
            To stop it, freeze the vault or replace its agent; a grant also ends when it expires. What you trust: whoever
            runs the connector can ask the enclave to sign for a vault with a live grant, so the worst case is payments to
            your payees within your limits, and held payments you can veto.
          </p>
        </section>

        <section id="apps">
          <h2>Add to an AI app</h2>
          <p>
            Any app that adds a remote MCP server by URL, with OAuth sign-in, can use a hosted vault. Each one then sends
            you here to sign the grant.
          </p>
          <table>
            <tbody>
              {HOSTED_TABS.map(({ id, label }) => {
                const { steps, text } = hostedSnippetFor(id, HOSTED_URL);
                return (
                  <tr key={id}>
                    <td>{label}</td>
                    <td>
                      {steps}
                      {text !== HOSTED_URL && <Code>{text}</Code>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section id="mcp">
          <h2>MCP server, run yourself</h2>
          <p>
            For a vault whose agent key you hold. It gives any MCP client eleven tools: <code>pay</code>,{" "}
            <code>quote_payment</code>, <code>list_destinations</code>, <code>get_payment_status</code>,{" "}
            <code>list_payees</code>, <code>get_balances</code>, <code>get_addresses</code>, <code>list_queue</code> and{" "}
            <code>execute_queued</code>, plus <code>search</code> and <code>fetch</code>, which ChatGPT uses to read the
            vault.{" "}
            {MCP_PUBLISHED ? (
              <>Your app starts it with npx, so there's nothing to install.</>
            ) : (
              <>It isn't on npm yet, so build it first:</>
            )}
          </p>
          {!MCP_PUBLISHED && <Code>{INSTALL}</Code>}
          {!MCP_PUBLISHED && (
            <p className="muted small">
              Then replace <code>/path/to/covenant</code> below with your clone's path.
            </p>
          )}
          <p>
            <strong>Claude Desktop</strong>: in <code>claude_desktop_config.json</code> (macOS:{" "}
            <code>~/Library/Application Support/Claude/</code>, Windows: <code>%APPDATA%\Claude\</code>), under{" "}
            <code>mcpServers</code>, then quit and reopen Claude Desktop. <strong>Cursor</strong>: the same, in{" "}
            <code>~/.cursor/mcp.json</code>.
          </p>
          <Code>{MCP_DESKTOP}</Code>
          <p className="muted small">
            Claude Desktop doesn't read your shell's PATH. If Node came from nvm or similar, put the full path in{" "}
            <code>command</code>: run <code>which node</code> (or <code>which npx</code>) and paste what it prints. If the
            server doesn't appear, Settings → Developer shows its error.
          </p>
          <p>
            <strong>Claude Code</strong>: run this, then start <code>claude</code> and check <code>/mcp</code>.
          </p>
          <Code>{MCP_CODE}</Code>
          <p>
            <strong>VS Code</strong>: in <code>.vscode/mcp.json</code>.
          </p>
          <Code>{MCP_VSCODE}</Code>
          <p>
            It records payments in <code>~/.covenant/</code>, so none is paid twice; set <code>SPENDS_FILE</code> to keep
            them elsewhere. For Solana, run <code>VAULT_ACCOUNT_ID=&lt;vault&gt; npx -y @len3hq/covenant-mcp@latest sol-nonce</code> once and add the{" "}
            <code>SOL_NONCE_ACCOUNTS</code> it prints.{" "}
            <code>NEAR_RPC_URL</code> and <code>SOL_RPC_URL</code> choose other endpoints. To check it works, ask your
            assistant "what are my vault's addresses?".
          </p>
          <p className="muted small">
            The key in this config can only ask your vault for payments. If it leaks, the worst it can do is propose
            payments your rules allow and spend its 1 NEAR of gas. Still, keep the file private, and replace the agent if
            it leaks.
          </p>
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
                <td>
                  Asks the vault to pay. <code>asset</code> is <code>BTC</code>, <code>ETH</code>, <code>USDC</code> (on
                  Base), <code>SOL</code> or <code>USDC-SOL</code>, and <code>amount</code> is a bigint in base units. Add{" "}
                  <code>toChain</code> and <code>toAsset</code> to pay on another chain through Tidepool.
                </td>
              </tr>
              <tr>
                <td><code>execute(id)</code></td>
                <td>Signs and broadcasts a held payment once its window has passed. The vault checks it again.</td>
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
          <p>
            <strong>Keeping the key elsewhere.</strong> Instead of <code>agentKey</code>, pass a <code>signer</code> that
            holds the key in an enclave or HSM. It's how the hosted connector works.
          </p>
          <Code>{SDK_SIGNER}</Code>
          <p className="muted small">
            Amounts are always integers: sats, wei, lamports, and USDC's 6 decimals, so 1 USDC is <code>1_000_000n</code>.
            Keep <code>spendsFile</code> on storage that survives restarts.
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
                <td>
                  Held for a veto: large, or to an address that isn't a payee. It goes through after{" "}
                  <code>executableAt</code> unless it's vetoed first: the MCP server and hosted agents send it automatically,
                  and with the SDK, call <code>execute(id)</code>, or <code>executeDue()</code> for every one that's due, or
                  start <code>startAutoExecute(wallet)</code> to do it on a timer.
                </td>
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
            <li>
              <strong>Only your payees are paid at once.</strong> Anyone else is refused, or, if you allow it, paid only after
              the new-address wait and within the new-address limits. Bitcoin change goes back to the vault.
            </li>
            <li><strong>Limits hold</strong> per payment and per rolling 24 hours, including fees and across concurrent payments.</li>
            <li><strong>Held payments wait</strong> for the veto window, and are checked again against the rules in force when they execute.</li>
            <li><strong>The agent can't change the rules.</strong> Its key can't set policy, veto, freeze or move NEAR.</li>
            <li><strong>Vaults made by the factory can't be changed</strong> by anyone: they have no keys and run shared, published code.</li>
            <li><strong>A hosted agent's key never leaves its enclave</strong>, which signs only vault calls an owner's live grant covers.</li>
          </ul>
          <p>
            What a hijacked agent can still do: pay your payees within the limits, ask for held payments you'll see in the
            queue, and spend its key's gas allowance.
          </p>
          <p className="muted small">Testnet only, and not audited. Each claim maps to a named test in the repo's SECURITY.md.</p>
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
              <tr><td><code>propose_spend</code></td><td>Agent</td><td>Parse, check, then sign, hold or refuse a payment</td></tr>
              <tr><td><code>execute</code></td><td>Agent</td><td>Sign a held payment after its window, re-checking the rules</td></tr>
              <tr><td><code>veto</code></td><td>Owner, guardian</td><td>Cancel a held payment</td></tr>
              <tr><td><code>freeze</code> / <code>unfreeze</code></td><td>Owner and guardian / owner</td><td>Stop or restart all signing</td></tr>
              <tr><td><code>set_policy</code></td><td>Owner</td><td>Change payees, limits and waits</td></tr>
              <tr><td><code>set_agent</code></td><td>Owner</td><td>Point the vault at another agent account</td></tr>
              <tr>
                <td><code>get_policy</code>, <code>get_queue</code>, <code>get_roles</code>, <code>get_addresses</code>, <code>is_frozen</code></td>
                <td>Anyone</td>
                <td>Read the vault</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">
            Vaults are created by <code>{FACTORY_ID}</code> with <code>create_vault</code>, and <code>vaults_of(owner)</code>{" "}
            lists an owner's vaults. Every vault emits NEP-297 events, which this dashboard reads.
          </p>
        </section>

        <section id="help">
          <h2>Troubleshooting</h2>
          <table>
            <tbody>
              <tr>
                <td>The wallet window never opens for the second signature</td>
                <td>
                  Browsers block a wallet window that opens on its own. Press <strong>Sign 2 of 2</strong>; if the page lost
                  track, press Replace agent or Create again with the same name, and it continues where it stopped.
                </td>
              </tr>
              <tr>
                <td>A Bitcoin payment says no inputs can fund it</td>
                <td>The vault only spends confirmed coins, apart from its own change. Wait for the faucet's payment to confirm.</td>
              </tr>
              <tr>
                <td>A Solana USDC payment fails after signing</td>
                <td>The recipient needs a USDC token account. Ask them to create one, or send them a little USDC from a wallet first.</td>
              </tr>
              <tr>
                <td>"Protocol state is not running"</td>
                <td>NEAR's MPC signer is upgrading its keys. Wait and try again; nothing was signed or charged.</td>
              </tr>
              <tr>
                <td>Claude Desktop doesn't show the server</td>
                <td>Use the full path to node or npx, check the JSON is valid, and look at Settings → Developer for the error.</td>
              </tr>
              <tr>
                <td>An AI app can't connect to a hosted vault</td>
                <td>
                  It must support remote MCP servers with OAuth. Check the vault's agent holds the enclave's key (its Agent tab
                  says so), and that your grant hasn't expired.
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </article>
    </div>
  );
}

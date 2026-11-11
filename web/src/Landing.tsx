/** The front page: what Covenant is, and where to go next. */
export function Landing({
  account,
  connect,
  demoVault,
}: {
  account: string | null;
  connect(): void;
  demoVault: string;
}) {
  return (
    <div className="landing">
      <section className="landing-hero">
        <p className="eyebrow">A wallet for AI agents · Bitcoin · Base · Solana</p>
        <h1>
          The agent can be fooled.
          <br />
          <span className="accent">The vault can't.</span>
        </h1>
        <p className="lede">
          Give an AI agent money without giving it your keys. It asks a Covenant vault to pay; a NEAR contract
          checks every payment against your rules, and only then does NEAR's MPC network sign it. No AI sits in the
          security path, and nobody, including us, can change the vault's code.
        </p>
        <div className="cta-row">
          <a className="button primary" href="?create">
            Create a vault
          </a>
          {account ? (
            <a className="button ghost" href="?mine">
              My vaults
            </a>
          ) : (
            <button type="button" className="ghost" onClick={connect}>
              Connect wallet
            </button>
          )}
          <a className="button ghost" href={`?vault=${encodeURIComponent(demoVault)}`}>
            See the live demo vault →
          </a>
        </div>
        <p className="muted small">Testnet only. Not audited. Every coin here is free test money.</p>
      </section>

      <section className="how">
        <h2>How it works</h2>
        <ol className="how-steps">
          <li className="card">
            <span className="how-number">1</span>
            <h3>Create a vault and set its rules</h3>
            <p className="muted">
              Who it may pay, how much per payment and per day, and how long large payments or new addresses wait so
              you can veto them. It gets its own Bitcoin, Base and Solana addresses.
            </p>
          </li>
          <li className="card">
            <span className="how-number">2</span>
            <h3>Connect your agent</h3>
            <p className="muted">
              Run it yourself with a key that can only ask this vault for payments, or keep the key in a secure
              enclave and add the vault to Claude, ChatGPT or any AI app by URL.
            </p>
          </li>
          <li className="card">
            <span className="how-number">3</span>
            <h3>Stay in control</h3>
            <p className="muted">
              The agent pays within your rules. Everything else is refused or held for you. Veto any held payment,
              freeze the vault in one click, or replace a leaked agent key.
            </p>
          </li>
        </ol>
      </section>

      <section className="features">
        {[
          ["Rules on-chain", "Limits, payees and veto windows live in the vault's NEAR contract, so a fooled agent can't argue past them."],
          ["Three chains, one vault", "Bitcoin testnet4, Base Sepolia and Solana devnet addresses, all derived from the vault through NEAR Chain Signatures."],
          ["Cross-chain payments", "Pay in another token on another chain through Tidepool. The vault checks the signed quote before it pays."],
          ["Veto and freeze", "Held payments wait for you. The owner or a guardian, even a DAO, can veto one or freeze everything."],
          ["Keys that can do one thing", "An agent's key can only ask its vault for payments. It can't move funds, change rules or touch anything else."],
          ["Hosted, if you like", "A hosted agent's key lives in an OutLayer TDX enclave that nobody can read, for AI apps on the web and phone."],
        ].map(([title, body]) => (
          <article key={title} className="card feature">
            <h3>{title}</h3>
            <p className="muted small">{body}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

const panels = [
  { title: "Balances", detail: "BTC, ETH and USDC, with spend in the last 24 h against each cap." },
  { title: "Policy", detail: "Caps, payees, fee and gas caps, veto delay and policy hash." },
  { title: "Queue", detail: "Queued spends with a countdown and a veto action." },
  { title: "Activity log", detail: "Signed, rejected, queued and vetoed spends, newest first." },
];

export function App() {
  return (
    <main>
      <header>
        <h1>Covenant</h1>
        <p>Not connected to a vault yet.</p>
      </header>
      <div className="panels">
        {panels.map(({ title, detail }) => (
          <section key={title}>
            <h2>{title}</h2>
            <p>{detail}</p>
          </section>
        ))}
      </div>
    </main>
  );
}

# Covenant: what's built, how it wins, and how it becomes a business

Written on 6 Nov 2026, eight days before the deadline (14 Nov, 20:00 UTC).

## The short version

Covenant lets an AI agent pay bills on Bitcoin and Base without ever holding a key. Every payment the agent
asks for goes to a NEAR smart contract that checks a fixed set of rules. Only if the contract agrees does
NEAR's MPC network produce a signature. A fooled agent can ask for anything, but it can't get a signature
for a payment the rules forbid.

The core is built and working on testnet. We have recorded proof of a real AI model being tricked by a
poisoned invoice into paying an attacker, and the contract refusing. This week I rebuilt the dashboard so
that moment is the first thing anyone sees.

The hackathon's own AI Security track brief asks for almost exactly this demo. That's our strongest card.
The business is the same product sold to anyone who lets software spend money: a rulebook for agent wallets
that the agent can't break and anyone can verify.

---

## 1. What Covenant is, in plain terms

Think of a company card with hard limits, except no one at the bank can bend them.

| Part | What it does |
| --- | --- |
| **The agent** | An AI (OpenAI or Claude) that reads invoices and decides what to pay. It holds no private keys. Its NEAR key may call only two contract methods, `propose_spend` and `execute`. |
| **The Covenant contract** | A Rust contract on NEAR (`covenant.len3hq.testnet`). It reads the raw Bitcoin or EVM transaction the agent proposes, works out where the money really goes, and checks it against the policy. |
| **The policy** | A payee list, a cap per payment, a cap per 24 hours, fee and gas caps, and allowed chains. Large payments wait in a veto queue (120 s on testnet). Anything not explicitly allowed is refused. |
| **NEAR Chain Signatures** | NEAR's MPC network holds the keys for the vault's Bitcoin and Base addresses. It signs only when the contract asks, and the contract asks only after every check passes. |
| **The humans** | The **owner** sets policy. A **guardian**, here a Sputnik DAO, can veto queued spends or freeze every chain at once, by vote. |
| **The dashboard** | A web page showing everything that happened, what was refused and why, what's waiting, and the buttons to veto or freeze. |

The key design choice is that **there's no AI in the security path.** Other projects use an AI to spot bad
payments, but an AI can be fooled too. Covenant's checks are ordinary code that runs the same way every
time.

---

## 2. What has been built (milestones M0–M9)

### The contract (`contracts/`)
- **Transaction reading.** A Bitcoin adapter reads every input and output of a transaction, including the
  vault's own change. An EVM adapter accepts exactly two shapes: a plain ETH transfer, or a plain ERC-20
  `transfer`. Anything else is refused, for example `CalldataNotAllowed`.
- **Policy engine.** Checks the payee list, per-payment caps, rolling 24-hour caps, fee rate and gas cost
  caps, and chain IDs. Integers only (sats, wei, token base units), never floats.
- **Veto queue.** Payments above a threshold wait. The owner or guardian can veto them, and when one
  executes, the contract checks it again against *today's* policy.
- **Freeze.** One call stops all signing on every chain. Vetoes still work while frozen.
- **DAO guardian.** The guardian role can be a Sputnik DAO, so freezing and vetoing need a council vote.
- **Testing.** 27 named attack tests (13 Bitcoin, 14 EVM). Property tests try thousands of mutated
  transactions to show that a change can't silently redirect money, and that the daily cap can't be
  exceeded whatever order things happen in. Every security claim in `SECURITY.md` maps to a named test.

### The agent (`agent/`)
- Works with OpenAI-compatible models and with Claude.
- **Never pays twice.** Every NEAR transaction is signed and its hash recorded before it's sent. After a
  timeout the agent looks up that hash; it never proposes again.
- Picks Bitcoin coins sensibly, including its own unconfirmed change, and leaves alone coins that a queued
  spend has reserved.
- Three scenarios:
  - `pay`: honest invoices.
  - `attack`: a poisoned invoice that tells the agent to pay an attacker.
  - `queue`: a large payment that waits and gets vetoed.

### The keyless demo (`make demo`)
Judges and the AI screening tools can run all three scenarios with no keys and no money. It starts a local
NEAR sandbox with the real contract, replays the recorded model decisions, and prints what was signed and
what was refused.

### Live proof on testnet (`EVIDENCE.md`)
- Real BTC (testnet4), USDC and ETH (Base Sepolia) payments signed through the agent's restricted key.
- **gpt-4o-mini fooled by the poisoned invoice** into trying to pay the attacker 600,000 sats. The contract
  refused (`OutputNotWhitelisted`), and no signature was ever requested.
- Claude refusing an unlisted address. A queued spend refused as too early, then executed.
- The DAO voting to veto a spend and to freeze the vault.
- A nightly GitHub job runs a live end-to-end check, which spends tiny amounts.

### The dashboard (`web/`), rebuilt this week
See section 3.

### Operations and docs
- CI runs Rust tests, TypeScript tests, the keyless demo and a secret scan (`gitleaks`) on every push.
- `SECURITY.md` covers the trust model, `NEAR_FEATURES.md` lists 23 links to exact code lines,
  `PRODUCTION.md` covers deployment and funding, and `docs/BUILD_PLAN.md` holds the schedule.

---

## 3. What I did in this last session

### Research
Three research tracks ran in parallel, and a writer turned them into a design brief, saved locally at
`reports/Hackathon winning dashboard UI.md` (not committed). The main findings:

1. **The track brief matches our demo.** NEAR's AI Security track example asks for "a prompt-injected
   agent tries to pay a known-bad address and gets stopped, with the log shown". It also asks for a
   function-call key scoped to one contract, with its limits explained. We already have both.
2. **AI agents screen every entry first.** Claude Code and Codex check that the project "runs and does what
   the README says" before humans look. The README needs plain "do X, see Y" steps.
3. **Judges reward something that works and looks like a real product.** Extra polish beyond that earns
   little. The common reasons projects lose are demos that can't be opened, buzzwords, dead time in the
   video, and no answer to "why does this need a blockchain?".
4. **Our closest rival is ENShell,** a 2026 ETHGlobal Cannes finalist. It's an on-chain firewall for agents
   that uses an **AI score** to decide what to block. Our difference is that a refused payment never gets
   a signature at all, and no AI is involved in the decision.
5. **Professional tools share one design language.** Safe, Fireblocks, Stripe Radar, Privy and Turnkey all
   use a few clear verdicts, rules written as sentences, the rule number on every block, and deny by
   default.

### The new dashboard
- **Dark console in NEAR's colours.** NEAR green `#00EC97` marks the brand and the contract only. Red means
  refused, amber means waiting, and green means signed. Fonts are self-hosted so a recorded demo makes no
  outside requests.
- **Hero.** "The agent can be fooled. The vault can't." Beside it, a big red **BLOCKED** card for the real
  attack:
  - the amount and the attacker's address, tagged "Not a payee";
  - `OutputNotWhitelisted` and the rule it broke (R1);
  - the payees that *are* allowed;
  - "0 BTC moved. The contract never asked the MPC network for a signature."
- **Flow diagram.** Agent → Covenant contract → MPC signer → chain. On a refusal, the line breaks in red at
  the contract and the later steps go grey.
- **Counters.** Payments refused, payments signed, and payments signed to an unlisted address (always 0).
- **Decision log.** A verdict on every row, with the plain-English reason, the error name, the rule
  number, the payment and a link to the NEAR transaction. You can filter by verdict and chain, and new
  rows slide in.
- **Side panels:**
  - the veto queue with a live countdown and a Veto button;
  - budget bars against the 24-hour caps;
  - the policy as 13 numbered rules ending in "Refuse everything else";
  - who can do what, including the agent's restricted key;
  - freeze and unfreeze controls for the owner and guardian.

### Two real problems found and fixed
1. **The attacker's address wasn't visible.** The contract refuses an unlisted address while reading the
   transaction, before it has a payment list to log, so the refusal record was empty. The dashboard now
   decodes the agent's original request from the NEAR transaction and shows where the money was meant to
   go. This is display only; the contract still decides everything.
2. **The dashboard could go blank during judging.** FastNEAR, the RPC we used, started rate-limiting us, and
   the page failed to load. It now falls back to drpc.org, then rpc.testnet.near.org.

### Checks
All TypeScript tests pass: 45 for the dashboard, 62 for the agent and 7 for the scripts, along with lint and
the production build. New tests cover the amount formatting (string arithmetic, no floats), the
policy-to-sentences translation, and decoding of Bitcoin and EVM requests. Committed locally as `9c06d1b`
but **not pushed yet**, waiting for your review.

---

## 4. How this helps us win

### Matching what judges look for

| What judges look for | How Covenant answers it |
| --- | --- |
| **Fits the track** (AI Security & Defense) | The demo *is* the track's example: a prompt-injected agent tries to pay an attacker and is stopped, with the log shown. |
| **Fits the track** (Agent Economy) | An agent really pays suppliers on two chains, within a budget, with human oversight. |
| **Technical depth** | Raw Bitcoin and EVM transaction parsing in a contract, Chain Signatures on two chains, a veto queue that re-checks policy, a DAO guardian, property tests. |
| **It works** | Live testnet transactions with explorer links, a nightly live check, and a keyless `make demo` that judges and screening tools can run in minutes. |
| **Originality** | No AI in the security path. A refused payment never gets a signature, which is a stronger guarantee than ENShell's AI score. |
| **Why a blockchain?** | The rules live in a public contract. The agent's owner, the payees and the auditors can all check them, and no company in the middle can quietly bend them. Chain Signatures let one NEAR contract control Bitcoin and Base addresses. |
| **Usability** | The new dashboard tells the story in five seconds: a red BLOCKED card, the attacker's address, and the rule it broke. |
| **Uses NEAR well** | Chain Signatures, function-call access keys, Sputnik DAO, NEP-297 events, all mapped to code in `NEAR_FEATURES.md`. |

### Passing the AI screen
Claude Code and Codex check that the project runs and matches the README. We have `make demo`, which needs
no keys, CI that runs it on every push, and a README that will spell out "run X, see Y". This screen is
where many entries fail and where we're well placed.

### What still has to happen to win

| When | What | Who |
| --- | --- | --- |
| Now | Review and approve the new dashboard, then I push it | You |
| Now | Decide on going public: make the repo public now, then host the dashboard on GitHub Pages | You decide, I do it |
| By 10 Nov | Wallet test: sign in as the owner, then freeze and unfreeze (issue #6) | You |
| By 10 Nov | Show the dashboard to someone outside the project and ask what got blocked | You |
| Before 11 Nov | Top up Base Sepolia to about 0.05 ETH and 20 USDC, so the low-funds warning goes away | You |
| 11 Nov | Record the live attack run (M10) | Both |
| 12 Nov | Final README with "do X, see Y" steps, repo public, `rc1` tag (M11) | Me |
| 13 Nov | Video and fresh-clone test. Remove the full-access keys after you confirm (M12, D6) | Both |
| 14 Nov | Submit: public repo, plus an X post tagging @NEARProtocol with #NEARHackathon. **It can't be edited after sending.** (M13) | You |

### Suggested video, 2–4 minutes in a real voice
1. **The problem, 0:00–0:25.** "AI agents are starting to pay for things. One poisoned invoice can make an
   agent send money to an attacker. Prompt filters don't reliably stop this."
2. **The idea, 0:25–0:50.** One sentence and the flow diagram: the agent proposes, the contract checks, and
   only then does NEAR's MPC network sign. There's no AI in the security path.
3. **The attack live, 0:50–1:50.** Show the poisoned invoice and the model being fooled. Cut to the
   dashboard: the red BLOCKED card, the attacker's address, `OutputNotWhitelisted`, "0 BTC moved". Click
   through to the NEAR transaction.
4. **Honest payments, 1:50–2:30.** A real BTC payment and a USDC payment signed and confirmed on the
   explorers.
5. **Human control, 2:30–3:10.** A large payment waits in the queue, and the DAO vetoes it. Then freeze.
6. **Close, 3:10–3:30.** "Run `make demo`, no keys needed." Show the repo link.

Cut the signing wait. Don't speed the video up, and don't use a synthetic voice.

---

## 5. How Covenant becomes a business

### The problem we'd be selling against
Companies are starting to let software agents spend money: paying suppliers, buying compute and data,
settling invoices, paying other agents. Each one needs a wallet. Today that usually means one of three
things:
- **The agent holds a key.** Fast, but one bad prompt can empty the wallet.
- **A human approves everything.** Safe, but it removes the point of having an agent.
- **A wallet provider enforces limits on its own servers.** Coinbase's CDP wallet policies, Privy and
  Turnkey all offer allow and deny rules for wallets they run. These work, but you're trusting the
  provider's infrastructure, the rules are usually per chain, and outsiders can't verify them.

### What Covenant offers that they don't
1. **Rules anyone can verify.** The policy sits in a public contract. A company's finance team, its
   auditors, its suppliers, or a DAO's members can all read the exact rules and every decision.
2. **No single company can bend the rules.** Not us, not the wallet provider. Changes come only from the
   owner, and can need a DAO vote.
3. **One rulebook for many chains.** Through Chain Signatures, one NEAR contract controls Bitcoin and EVM
   addresses today, and the design already reserves Solana. One budget and one payee list cover every
   chain.
4. **No AI in the security path.** That's a simple, explainable claim, and it's what risk and compliance
   teams will want to hear.
5. **Humans in the loop only where it matters.** Small payments flow, big ones wait for a veto window, and
   anyone authorised can freeze everything at once.

### Who would pay, earliest first
1. **Teams building agents on NEAR,** for example Shade Agents and NEAR AI builders. They're already on
   NEAR, already need Chain Signatures, and Covenant saves them from building a policy layer.
2. **DAOs and crypto-native companies** that pay contributors and suppliers across chains and want a
   budget with a veto, not a multisig ritual for every payment.
3. **AI-agent startups** that need to show customers or investors that their agents can't be talked into
   draining a wallet. "Our rules are on-chain and audited" is a sales line for them.
4. **Later, fintechs and enterprises** that run treasury or procurement agents. They need an audit, a
   mainnet deployment, compliance work and support before they'd buy.

### Ways to charge, which can be combined

| Model | How it works | Pros | Cons |
| --- | --- | --- | --- |
| **Hosted vaults (SaaS)** | We deploy and run a vault per customer: contract, agent integration, dashboard, alerts. Monthly fee by number of vaults or volume. | Recurring revenue, easy to start | We carry operational load |
| **Per-signature fee** | The contract takes a small fixed fee per signed payment, in NEAR or the paid asset. | Built into the product, grows with use | Must be transparent, and it competes with "free" open source forks |
| **Developer SDK and agent tools** | A drop-in toolkit for agent frameworks, for example an MCP server or tool package so any agent can pay through Covenant. Free tier, paid for higher volume or support. | Fast adoption | Monetises slowly |
| **Enterprise licence** | Self-hosted deployment, a custom policy (approval chains, per-supplier budgets), audit reports, support agreement. | Large contracts | Long sales cycles, and it needs an audit first |
| **Policy templates and monitoring** | Ready-made rulebooks (payroll, cloud bills, agent-to-agent payments), with alerting on refusals, freezes and low balances. | Upsell on any of the above | Only valuable once there's a user base |

**Suggested path:** start with the SDK and agent tools (free) plus hosted vaults (paid) for the first
customers in group 1. Add the per-signature fee once on mainnet, and sell enterprise licences only after an
audit.

### From hackathon entry to company

| Stage | Goal | What it takes |
| --- | --- | --- |
| **0. Hackathon (now to 18 Nov)** | Win or place, and get noticed by NEAR ecosystem teams | Everything in section 4 |
| **1. Validate (Dec–Jan)** | 10 conversations with agent builders and DAOs. Find out whether they'd use this and what they'd pay | A one-page pitch, the live dashboard, the demo video. Track how many ask for a pilot |
| **2. Pilot (Q1 2027)** | 2–3 teams running Covenant on testnet with their own agents | An agent toolkit (MCP or SDK), multi-vault support, alerts, a policy editor in the dashboard |
| **3. Mainnet (Q2 2027)** | First real money, with low caps | **An independent security audit**, mainnet keys held in multisigs and hardware wallets, the mainnet checklist in `PRODUCTION.md`, an incident runbook |
| **4. Grow** | Paying customers, more chains | Solana support (the design already reserves it), per-supplier budgets, approval chains, compliance reporting |

**Funding options:** NEAR Foundation and ecosystem grants, which are the natural first step after a good
hackathon result, then accelerators focused on AI and crypto, then a seed round once pilots show usage.

### Risks to be honest about
- **No audit yet.** The contract is limited to testnets, and no real funds should go in before an
  independent audit.
- **Dependence on NEAR's MPC network.** If Chain Signatures is slow, expensive or down, payments stop.
  Mainnet signing fees also need measuring.
- **Big players.** Coinbase, Privy, Turnkey and Fireblocks already sell wallet policies to agent builders,
  and a fast follower could add on-chain rules. Our edge is verifiability, multiple chains from one
  contract, and no single company in control, so we must lead with those.
- **Regulation.** Moving money for others can trigger licensing rules. Covenant is non-custodial (the
  customer owns the vault and the policy), which helps, but we need legal advice before taking customer
  funds on mainnet.
- **The agent market is young.** How fast companies really hand spending to agents is uncertain, so stage 1
  exists to check demand before building more.

### What to measure to know it's working
- Number of teams who try `make demo` or the SDK, and how many come back.
- Pilot vaults live, and payments per week through them.
- Refusals per week, which shows the protection is doing something.
- Conversations that end in "we'd pay for this", and at what price.

---

## 6. Decisions waiting on you

1. **Approve the new dashboard,** so I can push commit `9c06d1b`. Run `pnpm --filter @covenant/web dev` and
   open http://localhost:5173.
2. **Go public now?** I recommend yes. The secret scan is clean on the full history, and it lets us host
   the dashboard on GitHub Pages straight away.
3. **Top up the testnet ETH and USDC** before the 11 Nov recording.
4. **Keep this file private or publish it?** It's not committed. The business section may be better kept
   out of the public repo. Tell me if you'd like the hackathon part folded into the README instead.

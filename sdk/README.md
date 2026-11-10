# @len3hq/covenant-sdk

A wallet for AI agents that can't overspend. The agent asks a
[Covenant](https://github.com/Len3hq/covenant) vault on NEAR to pay. The vault reads every
transaction itself, checks it against the owner's rules, and only then has NEAR's MPC network sign
it.

```ts
import { Covenant } from "@len3hq/covenant-sdk";

const wallet = Covenant.connect({ vault, agentAccount, agentKey: process.env.AGENT_PRIVATE_KEY! });
await wallet.pay({ asset: "BTC", to: "Acme Hosting", amount: 20_000n, reference: "INV-1042" });
// Across chains, through Tidepool's testnet swaps:
await wallet.pay({ asset: "BTC", to: "<Solana address>", amount: 20_000n, reference: "INV-1043", toChain: "solana", toAsset: "USDC" });
```

Each payment ends `broadcast`, `queued` (held for a veto) or `rejected`, with the rule it broke. The
same `reference` never pays twice. It works on testnet only.

More in the [docs](https://dashboard-production-65f1.up.railway.app/?docs#sdk).

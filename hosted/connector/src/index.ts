// Runs the hosted connector. docs/HOSTED.md has the design; hosted/connector/README.md the settings.
import { Covenant } from "@len3hq/covenant-sdk";
import type { Wallet } from "@len3hq/covenant-mcp/server";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { ConnectorAuth, Sealer } from "./auth.js";
import { rpcChainView } from "./grant.js";
import { localKeyHolder, outlayerKeyHolder, type KeyHolder } from "./keyholder.js";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const publicUrl = env("PUBLIC_URL").replace(/\/$/, "");
const dashboardUrl = env("DASHBOARD_URL");
const nearRpcUrl = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const dataDir = process.env.DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });

const keyHolder: KeyHolder = process.env.LOCAL_AGENT_KEY
  ? localKeyHolder(process.env.LOCAL_AGENT_KEY)
  : outlayerKeyHolder({
      apiUrl: process.env.OUTLAYER_API_URL ?? "https://testnet-api.outlayer.ai",
      project: env("OUTLAYER_PROJECT"),
      paymentKey: env("OUTLAYER_PAYMENT_KEY"),
    });
if (process.env.LOCAL_AGENT_KEY) console.error("LOCAL_AGENT_KEY is set: signing in this process, not the enclave. Development only.");

const wallets = new Map<string, Wallet>();
const app = createApp({
  auth: new ConnectorAuth({ sealer: new Sealer(Buffer.from(env("CONNECTOR_SECRET"), "hex")), dashboardUrl, publicUrl }),
  keyHolder,
  chain: rpcChainView(nearRpcUrl),
  publicUrl,
  // DEV_DASHBOARD_ORIGINS adds local dashboards, such as http://localhost:5199, for development.
  dashboardOrigins: [
    new URL(dashboardUrl).origin,
    ...(process.env.DEV_DASHBOARD_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  ],
  wallet(terms, grant, publicKey) {
    const key = `${terms.vault}|${grant.signature}`;
    let wallet = wallets.get(key);
    if (!wallet) {
      wallet = Covenant.connect({
        vault: terms.vault,
        agentAccount: terms.agent,
        signer: keyHolder.signer(grant, publicKey),
        nearRpcUrl,
        spendsFile: join(dataDir, `${terms.vault}-spends.json`),
      });
      wallets.set(key, wallet);
    }
    return wallet;
  },
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.error(`Covenant connector on :${port}, public at ${publicUrl}`));

// Runs the hosted connector. docs/HOSTED.md has the design; hosted/connector/README.md the settings.
import { Covenant, startAutoExecute } from "@len3hq/covenant-sdk";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { ConnectorAuth, Sealer } from "./auth.js";
import { rpcChainView, type Grant, type Terms } from "./grant.js";
import { GrantStore } from "./grants.js";
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

const grants = new GrantStore(join(dataDir, "grants.json"));
const wallets = new Map<string, Covenant>();

/**
 * One wallet per vault, so its spends file has one writer: the MCP requests and the timer below
 * share it. Its signer uses the vault's newest grant at the moment it signs.
 */
function walletFor(terms: Terms, grant: Grant, publicKey: string): Covenant {
  grants.save(terms, grant);
  let wallet = wallets.get(terms.vault);
  if (!wallet) {
    wallet = Covenant.connect({
      vault: terms.vault,
      agentAccount: terms.agent,
      signer: {
        publicKey,
        sign: (call) => keyHolder.signer(grants.forVault(terms.vault)?.grant ?? grant, publicKey).sign(call),
      },
      nearRpcUrl,
      spendsFile: join(dataDir, `${terms.vault}-spends.json`),
    });
    wallets.set(terms.vault, wallet);
  }
  return wallet;
}

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
  wallet: walletFor,
  onGrant: (terms, grant) => grants.save(terms, grant),
});

// A held payment goes through unless vetoed: once its wait ends, send it for every vault with a
// live grant, even with no one signed in. The vault checks it against its rules again first, and
// the enclave checks the grant again before it signs. AUTO_EXECUTE=off turns this off.
if (process.env.AUTO_EXECUTE !== "off") {
  startAutoExecute(
    {
      async executeDue() {
        const live = grants.live();
        if (live.length === 0) return [];
        const publicKey = await keyHolder.publicKey();
        const rounds = await Promise.all(
          live.map(async ({ terms, grant }) => {
            try {
              return (await walletFor(terms, grant, publicKey).executeDue()).map((result) => ({ ...result, vault: terms.vault }));
            } catch (error) {
              return [{ id: "-", vault: terms.vault, error: error instanceof Error ? error.message : String(error) }];
            }
          }),
        );
        return rounds.flat();
      },
    },
    {
      onResult: (result) =>
        console.error(JSON.stringify({ step: "auto_execute", ...result }, (_, v: unknown) => (typeof v === "bigint" ? `${v}` : v))),
    },
  );
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.error(`Covenant connector on :${port}, public at ${publicUrl}`));

/*
 * Test funds for a vault. Tidepool's faucet sends its test USDC and USDT to an address on Base
 * Sepolia or Solana devnet, the same tokens the vault pays and swaps. Native coins for fees, and
 * testnet4 BTC, come from each chain's own faucet.
 */

export const TIDEPOOL_FAUCET = "https://www.usetidepool.tech/v0/faucet";

export interface FaucetLink {
  coin: string;
  name: string;
  url: string;
}

export const FAUCET_LINKS: FaucetLink[] = [
  { coin: "BTC on testnet4", name: "CypherFaucet", url: "https://cypherfaucet.com/btc-testnet" },
  { coin: "BTC on testnet4", name: "testnet4.info", url: "https://testnet4.info" },
  { coin: "ETH on Base Sepolia, for gas", name: "Base's faucet list", url: "https://docs.base.org/get-started/get-funds" },
  { coin: "SOL on devnet, for fees", name: "Solana faucet", url: "https://faucet.solana.com" },
  { coin: "NEAR on testnet, for the vault's storage", name: "NEAR faucet", url: "https://near-faucet.io" },
  { coin: "USDC and USDT on more chains", name: "Tidepool faucet", url: "https://www.usetidepool.tech/docs/guides/faucet" },
];

export type FaucetChain = "base" | "sol";

/** Asks Tidepool for 100 test USDC and 100 test USDT at `address`. Resolves to a sentence for the page. */
export async function requestTestTokens(
  chain: FaucetChain,
  address: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const where = chain === "base" ? "Base Sepolia" : "Solana devnet";
  try {
    const response = await fetcher(TIDEPOOL_FAUCET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain, address }),
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    if (response.ok) return { ok: true, message: `Sent 100 test USDC and 100 test USDT to the vault on ${where}.` };
    const reason = body.message ?? body.error ?? `Tidepool answered ${response.status}`;
    return { ok: false, message: `Tidepool didn't send any: ${reason}` };
  } catch (error) {
    return { ok: false, message: `Couldn't reach Tidepool's faucet: ${String(error)}` };
  }
}

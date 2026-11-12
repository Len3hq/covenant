/*
 * Test funds for a vault. Tidepool's faucet sends its test USDC and USDT to an address on Base
 * Sepolia or Solana devnet, the same tokens the vault pays and swaps. It only takes claims on its
 * own site, so the dashboard links there with the vault's address ready to copy. Native coins for
 * fees, and testnet4 BTC, come from each chain's own faucet.
 */

export const TIDEPOOL_FAUCET = "https://app.usetidepool.tech/faucet";

export interface FaucetLink {
  coin: string;
  name: string;
  url: string;
}

export const FAUCET_LINKS: FaucetLink[] = [
  { coin: "BTC on testnet4", name: "CypherFaucet", url: "https://cypherfaucet.com/btc-testnet" },
  { coin: "BTC on testnet4", name: "testnet4.info", url: "https://testnet4.info" },
  { coin: "BTC on testnet4", name: "mempool.space faucet", url: "https://mempool.space/testnet4/faucet" },
  { coin: "ETH on Base Sepolia, for gas", name: "Base's faucet list", url: "https://docs.base.org/get-started/get-funds" },
  { coin: "SOL on devnet, for fees", name: "Solana faucet", url: "https://faucet.solana.com" },
  { coin: "NEAR on testnet, for the vault's storage", name: "NEAR faucet", url: "https://docs.near.org/getting-started/faucet#external-faucet" },
  { coin: "USDC and USDT on Base Sepolia and Solana devnet", name: "Tidepool faucet", url: TIDEPOOL_FAUCET },
];

/** The vault's addresses to paste into a faucet, each with the coins it takes. */
export function faucetTargets(vault: { btcAddress: string; evmAddress: string; solAddress?: string | null }): {
  chain: string;
  coins: string;
  address: string;
}[] {
  return [
    { chain: "Bitcoin testnet4", coins: "BTC", address: vault.btcAddress },
    { chain: "Base Sepolia", coins: "ETH, and Tidepool's USDC", address: vault.evmAddress },
    ...(vault.solAddress ? [{ chain: "Solana devnet", coins: "SOL, and Tidepool's USDC", address: vault.solAddress }] : []),
  ];
}

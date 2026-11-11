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
  { coin: "ETH on Base Sepolia, for gas", name: "Base's faucet list", url: "https://docs.base.org/get-started/get-funds" },
  { coin: "SOL on devnet, for fees", name: "Solana faucet", url: "https://faucet.solana.com" },
  { coin: "NEAR on testnet, for the vault's storage", name: "NEAR faucet", url: "https://near-faucet.io" },
  { coin: "USDC and USDT on Base Sepolia and Solana devnet", name: "Tidepool faucet", url: TIDEPOOL_FAUCET },
];

/** The vault addresses Tidepool's faucet can send test USDC to, labelled as its form names them. */
export function tidepoolTargets(evmAddress: string, solAddress?: string | null): { chain: string; address: string }[] {
  return [
    { chain: "Base Sepolia", address: evmAddress },
    ...(solAddress ? [{ chain: "Solana devnet", address: solAddress }] : []),
  ];
}

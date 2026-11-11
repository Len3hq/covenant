import { describe, expect, it } from "vitest";
import { FAUCET_LINKS, TIDEPOOL_FAUCET, faucetTargets } from "./faucet";

describe("faucetTargets", () => {
  it("offers the vault's Bitcoin and Base addresses, and its Solana address when it has one", () => {
    const vault = { btcAddress: "tb1q05", evmAddress: "0xa7" };
    expect(faucetTargets(vault).map((target) => [target.chain, target.address])).toEqual([
      ["Bitcoin testnet4", "tb1q05"],
      ["Base Sepolia", "0xa7"],
    ]);
    expect(faucetTargets({ ...vault, solAddress: "FX2V" }).at(-1)).toMatchObject({ chain: "Solana devnet", address: "FX2V" });
  });
});

describe("FAUCET_LINKS", () => {
  it("lists a faucet for every coin the vault needs", () => {
    const coins = FAUCET_LINKS.map((link) => link.coin).join(" ");
    for (const coin of ["BTC", "ETH", "SOL", "NEAR", "USDC"]) expect(coins).toContain(coin);
  });

  it("sends USDC claims to Tidepool's own faucet page", () => {
    expect(FAUCET_LINKS.some((link) => link.url === TIDEPOOL_FAUCET)).toBe(true);
  });
});

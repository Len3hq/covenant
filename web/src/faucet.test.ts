import { describe, expect, it } from "vitest";
import { FAUCET_LINKS, TIDEPOOL_FAUCET, tidepoolTargets } from "./faucet";

describe("tidepoolTargets", () => {
  it("offers the vault's Base address, and its Solana address when it has one", () => {
    expect(tidepoolTargets("0xd913a8c28efdb2f30563e063b5fac5abd6ec9361")).toEqual([
      { chain: "Base Sepolia", address: "0xd913a8c28efdb2f30563e063b5fac5abd6ec9361" },
    ]);
    expect(tidepoolTargets("0xd9", "xR99")).toEqual([
      { chain: "Base Sepolia", address: "0xd9" },
      { chain: "Solana devnet", address: "xR99" },
    ]);
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

import { base58, base64, hex } from "@scure/base";
import vectorsJson from "../../tests/vectors/solana_message.json?raw";
import { describe, expect, it } from "vitest";
import { requestedPayments } from "./decode";
import { associatedTokenAccount, SOL_USDC_DEVNET, solanaKey, solanaPayments } from "./solana";
import { chainOfAsset, describeAsset, payeeAddress } from "./vault";
import { explorerFor, humanAmount } from "./story";

interface Vector {
  message: string;
  payee: string;
  payee_wallet: string;
  vault: string;
  vault_token_account: string;
  amount: string;
  mint: string | null;
}

const [SOL, USDC] = (
  JSON.parse(vectorsJson) as {
    vectors: Vector[];
  }
).vectors as [Vector, Vector];

describe("solana", () => {
  it("reads the payments in a message built by @solana/web3.js", () => {
    expect(solanaPayments(hex.decode(SOL.message))).toEqual([
      { asset: "Sol", to: [...hex.decode(SOL.payee)], amount: SOL.amount },
    ]);
    expect(solanaPayments(hex.decode(USDC.message))).toEqual([
      { asset: { Spl: { mint: [...hex.decode(USDC.mint ?? "")] } }, to: [...hex.decode(USDC.payee)], amount: USDC.amount },
    ]);
  });

  it("decodes what the agent asked for from propose_spend arguments", () => {
    const args = { chain: "Solana", tx: base64.encode(hex.decode(SOL.message)), meta: "Solana" };
    const encoded = base64.encode(new TextEncoder().encode(JSON.stringify(args)));
    expect(requestedPayments(encoded)).toHaveLength(1);
  });

  it("derives the associated token account web3.js does", () => {
    const account = associatedTokenAccount(hex.decode(USDC.vault), base58.decode(SOL_USDC_DEVNET));
    expect(base58.encode(account)).toBe(USDC.vault_token_account);
  });

  it("names Solana assets, addresses and explorers", () => {
    const usdc = { Spl: { mint: [...base58.decode(SOL_USDC_DEVNET)] } };
    expect(describeAsset(usdc).name).toBe("USDC on Solana");
    expect(humanAmount(usdc, "2500000")).toBe("2.5 USDC");
    expect(humanAmount("Sol", "1500000000")).toBe("1.5 SOL");
    expect(chainOfAsset("Sol")).toBe("Solana");
    expect(payeeAddress("Solana", [...hex.decode(SOL.payee)])).toBe(SOL.payee_wallet);
    expect(explorerFor("Solana", SOL.payee_wallet)).toContain("cluster=devnet");
  });

  it("refuses something that isn't a Solana address", () => {
    expect(() => solanaKey("tb1qnotsolana")).toThrow(/isn't a Solana address/);
  });
});

import { withRetry } from "../retry.js";
import type { Utxo } from "./tx.js";

const REQUEST_TIMEOUT_MS = 15_000;

interface ApiUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean };
}

/** The mempool.space API, for example `https://mempool.space/testnet4/api`. */
export class Mempool {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    // Reads are safe to repeat, and so is broadcasting a signed transaction.
    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response;
    });
  }

  /**
   * Confirmed coins, plus unconfirmed change from the vault's own payments. Blocks can be 20 minutes
   * apart, so without that change a second payment would have to wait. Anyone else's unconfirmed
   * coin is left out, because its sender could still replace it.
   */
  async spendableUtxos(address: string): Promise<Utxo[]> {
    const response = await this.request(`/address/${address}/utxo`);
    const utxos = (await response.json()) as ApiUtxo[];
    const usable = await Promise.all(
      utxos.map(async (utxo) => utxo.status.confirmed || this.isOwnChange(utxo.txid, address)),
    );
    return utxos
      .filter((_, index) => usable[index])
      .map(({ txid, vout, value }) => ({ txid, vout, value: BigInt(value) }));
  }

  private async isOwnChange(txid: string, address: string): Promise<boolean> {
    const { vin } = (await (await this.request(`/tx/${txid}`)).json()) as {
      vin: { prevout: { scriptpubkey_address?: string } | null }[];
    };
    return vin.every((input) => input.prevout?.scriptpubkey_address === address);
  }

  async txHex(txid: string): Promise<string> {
    return (await this.request(`/tx/${txid}/hex`)).text();
  }

  /** Whole sats per vbyte, rounded up. */
  async feeRate(): Promise<bigint> {
    const response = await this.request("/v1/fees/recommended");
    const { halfHourFee } = (await response.json()) as { halfHourFee: number };
    return BigInt(Math.ceil(halfHourFee));
  }

  /** Returns the txid. */
  async broadcast(txHex: string): Promise<string> {
    return (await this.request("/tx", { method: "POST", body: txHex })).text();
  }
}

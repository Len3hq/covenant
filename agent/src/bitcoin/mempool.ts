import type { Utxo } from "./tx.js";

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
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response;
  }

  async confirmedUtxos(address: string): Promise<Utxo[]> {
    const response = await this.request(`/address/${address}/utxo`);
    const utxos = (await response.json()) as ApiUtxo[];
    return utxos
      .filter((utxo) => utxo.status.confirmed)
      .map(({ txid, vout, value }) => ({ txid, vout, value: BigInt(value) }));
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

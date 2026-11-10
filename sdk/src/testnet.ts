import { networks, payments } from "bitcoinjs-lib";
import { createPublicClient, erc20Abi, getAddress, http, type Address } from "viem";
import { Mempool } from "./bitcoin/mempool.js";
import type { EvmChain } from "./evm/pay.js";
import type { Broadcasters } from "./payer.js";
import { associatedTokenAccount } from "./solana/message.js";
import type { SolanaDeps } from "./solana/pay.js";
import { SolanaRpc } from "./solana/rpc.js";
import { base58 } from "@scure/base";
import { connectVault, type AgentVault } from "./vault.js";

/** Public testnet endpoints. Each can be replaced. */
export const TESTNET = {
  nearRpcUrl: "https://rpc.testnet.near.org",
  btcApiUrl: "https://mempool.space/testnet4/api",
  evmRpcUrl: "https://sepolia.base.org",
  evmChainId: 84532,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  solRpcUrl: "https://api.devnet.solana.com",
  /** Circle's devnet USDC. */
  solUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
} as const;

export interface ConnectOptions {
  /** The vault's NEAR account, such as `acme.vaults.len3hq.testnet`. */
  vault: string;
  /** The agent's NEAR account. Its key should be a function-call key for this vault only. */
  agentAccount: string;
  /** `ed25519:...`. Keep it in an environment variable, never in code. */
  agentKey: string;
  nearRpcUrl?: string;
  btcApiUrl?: string;
  evmRpcUrl?: string;
  evmChainId?: number;
  usdc?: string;
  solRpcUrl?: string;
  solUsdcMint?: string;
  /**
   * Durable nonce accounts whose authority is the vault, from `make sol-nonce`. Solana payments need
   * at least one, and each unfinished payment holds one.
   */
  solNonceAccounts?: string[];
}

export interface ChainReads {
  btcBalance(): Promise<bigint>;
  ethBalance(): Promise<bigint>;
  tokenBalance(): Promise<bigint>;
  solBalance(): Promise<bigint>;
  solTokenBalance(): Promise<bigint>;
}

/** The vault, Bitcoin testnet4 and Base Sepolia, wired together. */
export function connectTestnet(options: ConnectOptions) {
  const vault: AgentVault = connectVault({
    rpcUrl: options.nearRpcUrl ?? TESTNET.nearRpcUrl,
    vault: options.vault,
    agent: options.agentAccount,
    agentKey: options.agentKey,
  });
  const client = createPublicClient({ transport: http(options.evmRpcUrl ?? TESTNET.evmRpcUrl) });
  const mempool = new Mempool(options.btcApiUrl ?? TESTNET.btcApiUrl);
  const usdc: Address = getAddress(options.usdc ?? TESTNET.usdc);
  const chain: EvmChain = {
    chainId: options.evmChainId ?? TESTNET.evmChainId,
    pendingNonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    fees: () => client.estimateFeesPerGas({ chain: null, type: "eip1559" }),
    estimateGas: ({ from, to, data }) => client.estimateGas({ account: from, to, data }),
    broadcast: (serializedTransaction) => client.sendRawTransaction({ serializedTransaction }),
  };
  const evmAddress = async () => (await vault.evmAddress()) as Address;
  const solRpc = new SolanaRpc(options.solRpcUrl ?? TESTNET.solRpcUrl);
  const solUsdcMint = base58.decode(options.solUsdcMint ?? TESTNET.solUsdcMint);
  const solana: SolanaDeps = {
    rpc: solRpc,
    vaultKey: () => vault.solPubkey(),
    nonceAccounts: options.solNonceAccounts ?? [],
    usdcMint: solUsdcMint,
  };
  const solAddress = async () => base58.encode(await vault.solPubkey());
  const btcAddress = async () => {
    const own = payments.p2wpkh({ pubkey: await vault.btcPubkey(), network: networks.testnet }).address;
    if (!own) throw new Error("could not derive the vault address");
    return own;
  };
  const broadcast: Broadcasters = {
    bitcoin: (signedHex) => mempool.broadcast(signedHex),
    evm: async (signedHex) => {
      const hash = await chain.broadcast(signedHex);
      // Confirmed before the next payment, so its nonce can't collide with this one.
      await client.waitForTransactionReceipt({ hash });
      return hash;
    },
    solana: (signedHex) => solRpc.sendAndConfirm(Buffer.from(signedHex, "hex")),
  };
  const reads: ChainReads = {
    async btcBalance() {
      const coins = await mempool.spendableUtxos(await btcAddress());
      return coins.reduce((total, coin) => total + coin.value, 0n);
    },
    ethBalance: async () => client.getBalance({ address: await evmAddress() }),
    tokenBalance: async () =>
      client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [await evmAddress()] }),
    solBalance: async () => solRpc.balance(await vault.solPubkey()),
    solTokenBalance: async () =>
      solRpc.tokenBalance(associatedTokenAccount(await vault.solPubkey(), solUsdcMint)),
  };
  return { vault, mempool, chain, usdc, broadcast, reads, btcAddress, evmAddress, solana, solAddress };
}

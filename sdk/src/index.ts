// The simple way in.
export { Covenant, quoteDeadline, tidepoolChain } from "./covenant.js";
export type { Balances, CovenantOptions, DueResult, Payee, PayRequest, Payment } from "./covenant.js";
export { startAutoExecute, type AutoExecuteOptions } from "./autoexecute.js";
export { ASSETS, type Asset } from "./payments.js";
export { TESTNET } from "./testnet.js";

// The parts it's built from, for agents that need more control.
export { connectTestnet, type ChainReads, type ConnectOptions } from "./testnet.js";
export { payeeAddress, prepareCall, preparePayment, resolvePayee, type PrepareDeps } from "./payments.js";
export { Payer, links, report, type Assemble, type Broadcasters, type Links, type SpendReport } from "./payer.js";
export { SpendStore, type Prepared, type SpendRecord, type SpendStatus } from "./store.js";
export * from "./vault.js";
export { agentCall, localRemoteSigner, RemoteNearSigner, transactionFromCall, type AgentCall, type RemoteSigner } from "./signer.js";
export { withRetry } from "./retry.js";
export * from "./tidepool.js";
export { jsonLog, type Log, type LogFields } from "./log.js";
export { Mempool } from "./bitcoin/mempool.js";
export * from "./bitcoin/pay.js";
export * from "./bitcoin/tx.js";
export * from "./bitcoin/witness.js";
export * from "./evm/pay.js";
export * from "./solana/message.js";
export * from "./solana/pay.js";
export { SolanaRpc, type NonceState } from "./solana/rpc.js";

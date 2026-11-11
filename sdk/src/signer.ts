import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import {
  actions,
  createTransaction,
  encodeTransaction,
  KeyPair,
  type KeyPairString,
  KeyType,
  PublicKey,
  Signature,
  SignedTransaction,
  Signer,
  type Transaction,
} from "near-api-js";

/**
 * The fields of one NEAR function call the agent signs. A remote signer rebuilds the transaction
 * from these, so it never signs bytes it was handed.
 */
export interface AgentCall {
  signerId: string;
  /** `ed25519:<base58>`, the agent's access key. */
  publicKey: string;
  nonce: string;
  receiverId: string;
  /** Base58, as NEAR RPC gives it. */
  blockHash: string;
  method: string;
  /** The call's argument bytes, base64. */
  args: string;
  gas: string;
}

/** Holds the agent's key somewhere else, such as an enclave, and signs one call at a time. */
export interface RemoteSigner {
  /** `ed25519:<base58>`. */
  publicKey: string;
  /** Answers the 64-byte ed25519 signature of the transaction built from `call`. */
  sign(call: AgentCall): Promise<Uint8Array>;
}

/** The only calls an agent key may make, matching its access key's method list. */
const AGENT_METHODS = new Set(["propose_spend", "execute"]);

/**
 * A near-api-js signer backed by a remote one. It signs only a single no-deposit function call,
 * and checks the answer against the transaction it built, so a signer that signed anything else
 * is caught before broadcast.
 */
export class RemoteNearSigner extends Signer {
  constructor(private readonly remote: RemoteSigner) {
    super();
  }

  async getPublicKey(): Promise<PublicKey> {
    return PublicKey.fromString(this.remote.publicKey);
  }

  protected async signBytes(): Promise<Uint8Array> {
    throw new Error("a remote agent signer signs only vault calls");
  }

  override async signNep413Message(): Promise<never> {
    throw new Error("a remote agent signer signs only vault calls");
  }

  override async signDelegateAction(): Promise<never> {
    throw new Error("a remote agent signer signs only vault calls");
  }

  override async signTransaction(transaction: Transaction): Promise<{ txHash: Uint8Array; signedTransaction: SignedTransaction }> {
    const call = agentCall(transaction);
    const signature = await this.remote.sign(call);
    const hash = sha256(encodeTransaction(transaction));
    const key = transaction.publicKey.data;
    if (signature.length !== 64 || !ed25519.verify(signature, hash, key)) {
      throw new Error("the remote signer's signature doesn't match the transaction");
    }
    const signed = new SignedTransaction({
      transaction,
      signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
    });
    return { txHash: hash, signedTransaction: signed };
  }
}

/** The fields of a transaction that's one vault call with no deposit, or an error naming why not. */
export function agentCall(transaction: Transaction): AgentCall {
  const [action, ...rest] = transaction.actions;
  const call = action?.functionCall;
  if (!call || rest.length > 0) throw new Error("an agent transaction is exactly one function call");
  if (call.deposit !== 0n) throw new Error("an agent call attaches no deposit");
  if (!AGENT_METHODS.has(call.methodName)) throw new Error(`an agent may not call ${call.methodName}`);
  if (transaction.publicKey.keyType !== KeyType.ED25519) throw new Error("an agent key is ed25519");
  return {
    signerId: transaction.signerId,
    publicKey: transaction.publicKey.toString(),
    nonce: transaction.nonce.toString(),
    receiverId: transaction.receiverId,
    blockHash: base58.encode(transaction.blockHash),
    method: call.methodName,
    args: Buffer.from(call.args).toString("base64"),
    gas: call.gas.toString(),
  };
}

/** The transaction an `AgentCall` describes, rebuilt from its fields as a remote signer does. */
export function transactionFromCall(call: AgentCall): Transaction {
  if (!AGENT_METHODS.has(call.method)) throw new Error(`an agent may not call ${call.method}`);
  return createTransaction(
    call.signerId,
    PublicKey.fromString(call.publicKey),
    call.receiverId,
    BigInt(call.nonce),
    [actions.functionCall(call.method, Buffer.from(call.args, "base64"), BigInt(call.gas), 0n)],
    base58.decode(call.blockHash),
  );
}

/**
 * A remote signer that holds the key in this process. For tests and local development of
 * something that will use an enclave: it signs only what `transactionFromCall` rebuilds.
 */
export function localRemoteSigner(secret: string): RemoteSigner {
  const key = KeyPair.fromString(secret as KeyPairString);
  return {
    publicKey: key.getPublicKey().toString(),
    async sign(call) {
      if (call.publicKey !== key.getPublicKey().toString()) throw new Error("that call is for another key");
      return key.sign(sha256(encodeTransaction(transactionFromCall(call)))).signature;
    },
  };
}

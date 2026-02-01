/**
 * Accumulate Network Types
 *
 * Type definitions for Accumulate JSON-RPC API responses and data structures.
 */

/**
 * Accumulate account types
 */
export type AccumulateAccountType =
  | 'identity'
  | 'tokenAccount'
  | 'liteTokenAccount'
  | 'dataAccount'
  | 'liteDataAccount'
  | 'keyBook'
  | 'keyPage'
  | 'unknown';

/**
 * Base Accumulate account
 */
export interface AccumulateAccount {
  type: AccumulateAccountType;
  url: string;
  balance?: string;
  creditBalance?: number;
}

/**
 * Key page account
 */
export interface AccumulateKeyPage extends AccumulateAccount {
  type: 'keyPage';
  version: number;
  threshold: number;
  creditBalance: number;
  keys: AccumulateKeyEntry[];
}

/**
 * Key entry in a key page
 */
export interface AccumulateKeyEntry {
  publicKeyHash: string;
  delegate?: string;
  lastUsedOn?: number;
  keyType?: string;
}

/**
 * Pending transaction from Accumulate
 */
export interface AccumulatePendingTx {
  txId: string;
  hash: string;
  principal: string;
  type: string;
  status: string;
  signatures: AccumulateSignature[];
  expiresAt?: Date;
  data?: AccumulateTransactionBody;
}

/**
 * Signature on a transaction
 */
export interface AccumulateSignature {
  signer: string;
  publicKeyHash: string;
  signature: string;
  timestamp: Date;
  vote?: 'approve' | 'reject' | 'abstain';
  transactionHash?: string;
}

/**
 * Transaction body (varies by type)
 */
export interface AccumulateTransactionBody {
  type: string;
  recipient?: string;
  amount?: string;
  token?: string;
  data?: unknown;
  memo?: string;
  metadata?: Record<string, unknown>;
  expire?: number;
  authorities?: string[];
  operations?: AccumulateKeyPageOperation[];
}

/**
 * Key page operation
 */
export interface AccumulateKeyPageOperation {
  type: 'add' | 'remove' | 'update' | 'setThreshold' | 'updateAllowed';
  entry?: {
    delegate?: string;
    publicKeyHash?: string;
    keyType?: string;
  };
  threshold?: number;
  allowed?: string[];
}

/**
 * Signature chain entry
 */
export interface SignatureChainEntry {
  type: string;
  txId: string;
  hash: string;
  principal: string;
  status: string;
  body?: AccumulateTransactionBody;
  signatures?: AccumulateSignature[];
}

/**
 * Transaction status codes
 */
export enum AccumulateStatusCode {
  OK = 'delivered',
  PENDING = 'pending',
  REMOTE = 'remote',
  FAILED = 'failed',
  EXPIRED = 'expired',
}

/**
 * Directory query response
 */
export interface DirectoryQueryResponse {
  type: string;
  entries: string[];
  total: number;
  start: number;
  count: number;
}

/**
 * Pending query response
 */
export interface PendingQueryResponse {
  type: string;
  items: PendingItem[];
  total: number;
  start: number;
  count: number;
}

/**
 * Pending item in query response
 */
export interface PendingItem {
  txid: string;
  hash: string;
}

/**
 * Transaction query response
 */
export interface TransactionQueryResponse {
  type: string;
  status: {
    code: string;
    delivered: boolean;
    pending: boolean;
    failed: boolean;
  };
  transaction: {
    header: {
      principal: string;
      initiator: string;
      memo?: string;
      metadata?: Record<string, unknown>;
      expire?: number;
    };
    body: AccumulateTransactionBody;
  };
  signatures: SignatureSetResponse[];
  produced?: ProducedTransaction[];
}

/**
 * Signature set in transaction response
 */
export interface SignatureSetResponse {
  signer: {
    url: string;
    acceptThreshold: number;
    rejectThreshold?: number;
  };
  signatures: SignatureResponse[];
  vote?: 'accept' | 'reject' | 'abstain';
}

/**
 * Individual signature in response
 */
export interface SignatureResponse {
  type: string;
  publicKeyHash?: string;
  signature?: string;
  signer?: string;
  timestamp?: number;
  vote?: string;
  transactionHash?: string;
  delegator?: string;
}

/**
 * Produced transaction (result of a transaction)
 */
export interface ProducedTransaction {
  hash: string;
  txid: string;
}

/**
 * Chain query response
 */
export interface ChainQueryResponse {
  type: string;
  name: string;
  head: string;
  height: number;
  roots?: string[];
}

/**
 * JSON-RPC request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params: unknown;
}

/**
 * JSON-RPC response
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: JsonRpcError;
}

/**
 * JSON-RPC error
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Pending Discovery Types
 *
 * Type definitions for the pending transaction discovery algorithm.
 */

import { AccumulatePendingTx, AccumulateSignature } from './accumulate.types';

/**
 * Discovered signing path (delegation chain)
 */
export interface SigningPath {
  /** Human-readable path representation: "acc://a.acme/book/1 -> acc://b.acme/book/1" */
  path: string;
  /** Individual key page URLs in order */
  hops: string[];
  /** Last hop in the chain (where pending transactions are queried) */
  finalSigner: string;
  /** When this path was discovered */
  discoveredAt: Date;
}

/**
 * Eligible transaction discovered by the algorithm
 */
export interface EligibleTransaction {
  /** The pending transaction */
  tx: AccumulatePendingTx;
  /** All signing paths that can sign this transaction */
  eligiblePaths: string[];
  /** Category for the transaction */
  category: 'initiated_by_user' | 'requiring_signature';
}

/**
 * Result of discovery for a single user
 */
export interface DiscoveryResult {
  /** Transactions eligible for signing */
  eligibleTransactions: EligibleTransaction[];
  /** Total count */
  totalCount: number;
  /** All signatures by transaction hash */
  signatures: Map<string, AccumulateSignature[]>;
}

/**
 * Result of state update operation
 */
export interface UpdateResult {
  success: boolean;
  added: number;
  removed: number;
  cycleToken: string;
}

/**
 * Statistics for a polling cycle
 */
export interface PollStats {
  /** Total users in system */
  totalUsers: number;
  /** Users successfully processed */
  processedUsers: number;
  /** Users skipped (no ADIs) */
  skippedUsers: number;
  /** Users that failed processing */
  failedUsers: number;
  /** Total pending transactions found */
  totalPending: number;
  /** Firestore write operations */
  firestoreWrites: number;
  /** Duration of the poll cycle in ms */
  duration: number;
}

/**
 * Create default poll stats
 */
export function createPollStats(): PollStats {
  return {
    totalUsers: 0,
    processedUsers: 0,
    skippedUsers: 0,
    failedUsers: 0,
    totalPending: 0,
    firestoreWrites: 0,
    duration: 0,
  };
}

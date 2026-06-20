/**
 * Pending Discovery Types
 *
 * Type definitions for the pending transaction discovery algorithm.
 */

import { AccumulatePendingTx, AccumulateSignature } from './accumulate.types';

/**
 * Structured metadata for a single hop in a signing path
 */
export interface SigningPathHop {
  /** Key page URL */
  url: string;
  /** Parent key book URL */
  keyBookUrl: string;
  /** Parent ADI URL */
  adiUrl: string;
  /** Accept threshold (M of M-of-N) */
  threshold: number;
  /** Total entries on the key page (N) */
  totalEntries: number;
  /** Whether this hop is a delegate hop (not the origin page) */
  isDelegateHop: boolean;
}

/**
 * Discovered signing path (delegation chain)
 */
export interface SigningPath {
  /** Human-readable path representation: "acc://a.acme/book/1 -> acc://b.acme/book/1" */
  path: string;
  /** Individual key page URLs in order */
  hops: string[];
  /** Structured metadata for each hop */
  structuredHops: SigningPathHop[];
  /** Last hop in the chain (where pending transactions are queried) */
  finalSigner: string;
  /** Whether this is a direct (single-hop) path */
  directPath: boolean;
  /** Delegation depth (number of hops) */
  depth: number;
  /** When this path was discovered */
  discoveredAt: Date;
}

/**
 * Eligible transaction discovered by the algorithm.
 * Uniqueness is per (tx, adiUrl) — the same tx can surface under multiple of a
 * user's ADIs when foreign-delegate signing is involved, with independent state.
 */
export interface EligibleTransaction {
  /** The pending transaction */
  tx: AccumulatePendingTx;
  /** ADI under whose perspective this entry surfaces (its keybook can sign) */
  adiUrl: string;
  /** Signing paths under this ADI that can sign this transaction */
  eligiblePaths: string[];
  /** Category for the transaction */
  category: 'governance' | 'transactions';
}

/**
 * Result of discovery for a single user
 */
export interface DiscoveryResult {
  /** Transactions eligible for signing */
  eligibleTransactions: EligibleTransaction[];
  /** Transactions user already signed, still awaiting other authorities */
  awaitingOthersTransactions: EligibleTransaction[];
  /** Total count (eligible only) */
  totalCount: number;
  /** Count of awaiting-others transactions */
  awaitingOthersCount: number;
  /** All signatures by transaction hash */
  signatures: Map<string, AccumulateSignature[]>;
  /**
   * True when a transient query failure (network/timeout/5xx after retries)
   * may have made this discovery incomplete. The reconciler MUST NOT remove
   * existing pending actions on a degraded cycle, or a blip would wipe a
   * user's inbox.
   */
  degraded: boolean;
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
  /** Users whose cycle was degraded (transient failures; removals skipped) */
  degradedUsers: number;
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
    degradedUsers: 0,
    duration: 0,
  };
}

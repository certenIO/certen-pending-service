/**
 * Firestore Document Types
 *
 * Type definitions for Firestore documents used by the pending discovery service.
 * These match the schema in the web app's firebase.service.ts.
 */

import { Timestamp } from 'firebase-admin/firestore';

/**
 * User document from Firestore with ADI key pages
 */
export interface CertenUser {
  uid: string;
  email: string;
  displayName?: string | null;
  defaultAdiUrl: string | null;
  onboardingComplete: boolean;
  keyVaultSetup: boolean;
}

/**
 * ADI with key pages for signature matching
 */
export interface CertenAdi {
  adiUrl: string;
  adiName?: string;
  keyBooks: CertenKeyBook[];
  accounts: CertenAdiAccount[];
  linkedChains: CertenLinkedChain[];
  isActive: boolean;
  creditBalance: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Key book structure
 */
export interface CertenKeyBook {
  url: string;
  keyPages: CertenKeyPage[];
  authority?: string;
}

/**
 * Key page with entries
 */
export interface CertenKeyPage {
  url: string;
  version: number;
  threshold: number;
  creditBalance: number;
  entries: CertenKeyEntry[];
  acceptThreshold?: number;
  rejectThreshold?: number;
}

/**
 * Key page entry (key or delegate)
 */
export interface CertenKeyEntry {
  type: 'key' | 'delegate';
  publicKeyHash?: string;
  keyType?: string;
  delegateUrl?: string;
  lastUsedHeight?: number;
}

/**
 * ADI account (token, data, etc.)
 */
export interface CertenAdiAccount {
  url: string;
  type: 'dataAccount' | 'tokenAccount' | 'liteTokenAccount' | 'liteDataAccount' | 'keyBook' | 'keyPage';
  authorities: string[];
  tokenUrl?: string;
  balance?: string;
  tokenSymbol?: string;
  dataEntryCount?: number;
  isActive?: boolean;
  createdAt?: Timestamp;
}

/**
 * Linked external chain
 */
export interface CertenLinkedChain {
  chainId: string;
  networkType: 'mainnet' | 'testnet' | 'devnet';
  chainName?: string;
  address: string;
  addressType: 'eoa' | 'contract' | 'abstract_account' | 'multisig';
  publicKey?: string;
  publicKeyHash?: string;
  verified: boolean;
  addedAt: Timestamp;
  lastUsedAt: Timestamp | null;
}

/**
 * Full user with ADIs for processing
 */
export interface CertenUserWithAdis {
  uid: string;
  email: string;
  displayName?: string | null;
  defaultAdiUrl: string | null;
  adis: CertenAdi[];
}

/**
 * Signature record stored in pending action
 */
export interface SignatureRecord {
  signer: string;
  publicKeyHash: string;
  vote: 'approve' | 'reject' | 'abstain';
  signedAt: Timestamp;
}

/**
 * Pending action document stored in Firestore
 * Path: /users/{uid}/pendingActions/{normalizedTxHash}
 */
export interface PendingActionDocument {
  id: string;
  category: 'governance' | 'transactions';
  type: 'transaction' | 'signature_request' | 'delegation_request';
  status: 'pending' | 'awaiting_signatures' | 'partially_signed';

  // Transaction details
  txHash: string;
  txId: string;
  principal: string;
  transactionType: string;

  // Signature tracking
  collectedSignatures: number;
  signatures: SignatureRecord[];

  // User's signing context
  eligibleSigningPaths: string[];
  userHasSigned: boolean;

  // Timing
  createdAt: Timestamp;
  updatedAt: Timestamp;
  expiresAt?: Timestamp;
  discoveredAt: Timestamp;
}

/**
 * Computed state for badge counts
 * Path: /users/{uid}/computedState/pending
 */
export interface ComputedPendingState {
  count: number;
  urgentCount: number;
  governanceCount: number;
  transactionsCount: number;
  txHashes: string[];
  computedAt: Timestamp;
  cycleToken: string;
}

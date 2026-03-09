/**
 * State Manager Service
 *
 * Handles atomic updates to Firestore for pending actions and computed state.
 */

import * as crypto from 'crypto';
import { FirestoreClient } from '../clients/firestore.client';
import { AppConfig } from '../config';
import {
  DiscoveryResult,
  EligibleTransaction,
  PendingActionDocument,
  ComputedPendingState,
  UpdateResult,
  AccumulateSignature,
  SignatureRecord,
  AuthoritySigningStatus,
  AuthorityPageStatus,
} from '../types';
import { normalizeHash } from '../utils/hash-normalizer';
import { logger } from '../utils/logger';
import { Timestamp } from 'firebase-admin/firestore';

export class StateManagerService {
  private readonly firestore: FirestoreClient;
  private readonly config: AppConfig;

  constructor(firestore: FirestoreClient, config: AppConfig) {
    this.firestore = firestore;
    this.config = config;
  }

  /**
   * Atomically update user's pending actions in Firestore
   * Uses idempotency tokens to prevent duplicate processing
   */
  async updateUserPendingState(
    uid: string,
    discovery: DiscoveryResult,
    previousCycleToken: string | null
  ): Promise<UpdateResult> {
    const cycleToken = this.generateCycleToken(uid);
    const now = this.firestore.now();

    // Get current pending actions to detect changes
    const currentPending = await this.firestore.getPendingActions(uid);
    const currentHashes = new Set(currentPending.map(p => p.id));

    // Combine eligible + awaiting_others hashes
    const allEligible = discovery.eligibleTransactions;
    const allAwaiting = discovery.awaitingOthersTransactions;
    const newHashes = new Set([
      ...allEligible.map(t => normalizeHash(t.tx.hash)),
      ...allAwaiting.map(t => normalizeHash(t.tx.hash)),
    ]);

    // Determine what to remove and what to add/update
    const toRemove: string[] = [];
    const toAdd: PendingActionDocument[] = [];

    // Remove pending actions that are no longer pending (either type)
    for (const doc of currentPending) {
      if (!newHashes.has(doc.id)) {
        toRemove.push(doc.id);
      }
    }

    // Add or update eligible transactions (needs user's signature)
    for (const eligible of allEligible) {
      const hash = normalizeHash(eligible.tx.hash);
      const signatures = discovery.signatures.get(hash) || eligible.tx.signatures;
      const pendingAction = this.buildPendingActionDocument(
        eligible,
        signatures,
        now,
        false
      );
      toAdd.push(pendingAction);
    }

    // Add or update awaiting-others transactions (user already signed)
    for (const awaiting of allAwaiting) {
      const hash = normalizeHash(awaiting.tx.hash);
      const signatures = discovery.signatures.get(hash) || awaiting.tx.signatures;
      const pendingAction = this.buildPendingActionDocument(
        awaiting,
        signatures,
        now,
        true
      );
      toAdd.push(pendingAction);
    }

    // Build computed state for quick badge access
    const computedState: ComputedPendingState = {
      count: discovery.totalCount,
      urgentCount: allEligible.filter(t =>
        t.tx.expiresAt && this.isUrgent(t.tx.expiresAt)
      ).length,
      governanceCount: allEligible.filter(t =>
        t.category === 'governance'
      ).length,
      transactionsCount: allEligible.filter(t =>
        t.category === 'transactions'
      ).length,
      awaitingOthersCount: discovery.awaitingOthersCount,
      txHashes: Array.from(newHashes),
      computedAt: now,
      cycleToken,
    };

    // Skip if dry run
    if (this.config.dryRun) {
      logger.info('Dry run - would update pending actions', {
        uid: uid.substring(0, 8),
        toAdd: toAdd.length,
        toRemove: toRemove.length,
      });

      return {
        success: true,
        added: toAdd.length - currentHashes.size,
        removed: toRemove.length,
        cycleToken,
      };
    }

    // Commit atomically
    await this.firestore.updatePendingActions(uid, toAdd, toRemove, computedState);

    logger.debug('Updated pending state', {
      uid: uid.substring(0, 8),
      added: toAdd.length,
      removed: toRemove.length,
      eligible: discovery.totalCount,
      awaitingOthers: discovery.awaitingOthersCount,
    });

    return {
      success: true,
      added: toAdd.length - currentHashes.size,
      removed: toRemove.length,
      cycleToken,
    };
  }

  /**
   * Build a pending action document from an eligible transaction
   */
  private buildPendingActionDocument(
    eligible: EligibleTransaction,
    signatures: AccumulateSignature[],
    now: Timestamp,
    userHasSigned: boolean
  ): PendingActionDocument {
    const tx = eligible.tx;

    let status: PendingActionDocument['status'];
    if (userHasSigned) {
      status = 'awaiting_others';
    } else if (signatures.length > 0) {
      status = 'partially_signed';
    } else {
      status = 'pending';
    }

    // Build per-authority breakdown from signatureBooks
    const authorities = this.buildAuthorityStatus(tx, now);

    const doc: PendingActionDocument = {
      id: normalizeHash(tx.hash),
      category: eligible.category,
      type: 'transaction',
      status,

      txHash: tx.hash,
      txId: tx.txId,
      principal: tx.principal,
      transactionType: tx.type,

      collectedSignatures: signatures.length,
      signatures: signatures.map(s => this.convertSignature(s, now)),

      authorities: authorities.length > 0 ? authorities : undefined,
      totalAuthorities: authorities.length > 0 ? authorities.length : undefined,
      approvedAuthorities: authorities.length > 0
        ? authorities.filter(a => a.approved).length
        : undefined,

      eligibleSigningPaths: eligible.eligiblePaths,
      userHasSigned,

      createdAt: now,
      updatedAt: now,
      discoveredAt: now,
    };

    // Only include expiresAt if present and valid (Firestore rejects undefined/NaN values)
    if (tx.expiresAt && !isNaN(tx.expiresAt.getTime())) {
      doc.expiresAt = this.firestore.createTimestamp(tx.expiresAt);
    }

    return doc;
  }

  /**
   * Build per-authority signing status from on-chain signatureBooks.
   * Also incorporates headerAuthorities to include authorities that haven't signed at all.
   */
  private buildAuthorityStatus(
    tx: import('../types').AccumulatePendingTx,
    now: Timestamp
  ): AuthoritySigningStatus[] {
    const authorityMap = new Map<string, AuthoritySigningStatus>();

    // Process signatureBooks from on-chain data
    if (tx.signatureBooks) {
      for (const book of tx.signatureBooks) {
        const pages: AuthorityPageStatus[] = book.pages.map(page => {
          const sigRecords = page.signatures.map(s => this.convertSignature(s, now));
          return {
            pageUrl: page.signer,
            acceptThreshold: page.acceptThreshold,
            signatures: sigRecords,
            thresholdMet: sigRecords.length >= page.acceptThreshold,
          };
        });

        const approved = pages.length > 0 && pages.some(p => p.thresholdMet);
        authorityMap.set(book.authority, {
          authorityUrl: book.authority,
          approved,
          signerPages: pages,
        });
      }
    }

    // Add header authorities that may not appear in signatureBooks yet (not signed)
    if (tx.headerAuthorities) {
      for (const authUrl of tx.headerAuthorities) {
        if (!authorityMap.has(authUrl)) {
          authorityMap.set(authUrl, {
            authorityUrl: authUrl,
            approved: false,
            signerPages: [],
          });
        }
      }
    }

    return Array.from(authorityMap.values());
  }

  /**
   * Convert AccumulateSignature to SignatureRecord
   */
  private convertSignature(sig: AccumulateSignature, now: Timestamp): SignatureRecord {
    return {
      signer: sig.signer,
      publicKeyHash: sig.publicKeyHash,
      vote: sig.vote || 'approve',
      signedAt: sig.timestamp
        ? this.firestore.createTimestamp(sig.timestamp)
        : now,
    };
  }

  /**
   * Check if a transaction is urgent (expiring within 24 hours)
   */
  private isUrgent(expiresAt: Date): boolean {
    const now = Date.now();
    const expiry = expiresAt.getTime();
    const timeRemaining = expiry - now;
    return timeRemaining < 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Generate an idempotency token for this cycle
   */
  private generateCycleToken(uid: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    const userHash = crypto
      .createHash('md5')
      .update(uid)
      .digest('hex')
      .substring(0, 8);
    return `${timestamp}_${random}_${userHash}`;
  }
}

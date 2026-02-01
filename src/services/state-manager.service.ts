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
  AccumulatePendingTx,
  SignatureRecord,
} from '../types';
import { normalizeHash } from '../utils/hash-normalizer';
import { extractAdiFromUrl } from '../utils/url-normalizer';
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
    const newHashes = new Set(
      discovery.eligibleTransactions.map(t => normalizeHash(t.tx.hash))
    );

    // Determine what to remove and what to add/update
    const toRemove: string[] = [];
    const toAdd: PendingActionDocument[] = [];

    // Remove pending actions that are no longer pending
    for (const doc of currentPending) {
      if (!newHashes.has(doc.id)) {
        toRemove.push(doc.id);
      }
    }

    // Add or update pending actions
    for (const eligible of discovery.eligibleTransactions) {
      const hash = normalizeHash(eligible.tx.hash);
      const signatures = discovery.signatures.get(hash) || eligible.tx.signatures;
      const pendingAction = this.buildPendingActionDocument(
        eligible,
        signatures,
        now
      );
      toAdd.push(pendingAction);
    }

    // Build computed state for quick badge access
    const computedState: ComputedPendingState = {
      count: discovery.totalCount,
      urgentCount: discovery.eligibleTransactions.filter(t =>
        t.tx.expiresAt && this.isUrgent(t.tx.expiresAt)
      ).length,
      initiatedCount: discovery.eligibleTransactions.filter(t =>
        t.category === 'initiated_by_user'
      ).length,
      requiresSignatureCount: discovery.eligibleTransactions.filter(t =>
        t.category === 'requiring_signature'
      ).length,
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
      total: discovery.totalCount,
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
    now: Timestamp
  ): PendingActionDocument {
    const tx = eligible.tx;
    const expiresAt = tx.expiresAt
      ? this.firestore.createTimestamp(tx.expiresAt)
      : undefined;
    const timeRemaining = expiresAt
      ? expiresAt.toMillis() - now.toMillis()
      : Number.MAX_SAFE_INTEGER;

    // Parse transaction body for details
    const txBody = tx.data || {};
    const recipient = (txBody as Record<string, unknown>).recipient as string | undefined;
    const amount = (txBody as Record<string, unknown>).amount as string | undefined;
    const token = (txBody as Record<string, unknown>).token as string | undefined;

    // Extract chain info from transaction type/data
    const chainInfo = this.extractChainInfo(tx);

    // Calculate required signatures from transaction data
    const requiredSignatures = this.extractRequiredSignatures(tx);

    return {
      id: normalizeHash(tx.hash),
      category: eligible.category,
      type: 'transaction',
      status: this.determineStatus(signatures.length, requiredSignatures),

      txHash: tx.hash,
      txId: tx.txId,
      principal: tx.principal,
      transactionType: tx.type,

      // Cross-chain details
      fromChain: chainInfo.fromChain,
      toChain: chainInfo.toChain,
      fromAddress: tx.principal,
      toAddress: recipient,
      amount,
      tokenSymbol: token ? this.extractTokenSymbol(token) : undefined,

      requiredSignatures,
      collectedSignatures: signatures.length,
      signatures: signatures.map(s => this.convertSignature(s, now)),

      eligibleSigningPaths: eligible.eligiblePaths,
      userHasSigned: false,

      createdAt: now,
      updatedAt: now,
      expiresAt,
      discoveredAt: now,

      urgencyLevel: this.calculateUrgency(timeRemaining),
      isExpiring: timeRemaining < 24 * 60 * 60 * 1000,
      timeRemaining,
    };
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
   * Extract chain information from transaction
   */
  private extractChainInfo(tx: AccumulatePendingTx): {
    fromChain?: string;
    toChain?: string;
  } {
    // Most transactions are Accumulate-only
    const result: { fromChain?: string; toChain?: string } = {
      fromChain: 'Accumulate',
    };

    // Check transaction type for cross-chain indicators
    const txType = tx.type.toLowerCase();
    if (txType.includes('burn') || txType.includes('bridge')) {
      // Could be a cross-chain burn/bridge
      const data = tx.data as Record<string, unknown> | undefined;
      if (data?.destination || data?.targetChain) {
        result.toChain = String(data.destination || data.targetChain);
      }
    }

    return result;
  }

  /**
   * Extract required signatures from transaction
   */
  private extractRequiredSignatures(tx: AccumulatePendingTx): number {
    // Default to 1 if we can't determine
    // In a real implementation, we'd query the authority structure
    const data = tx.data as Record<string, unknown> | undefined;
    if (data?.requiredSignatures) {
      return Number(data.requiredSignatures);
    }
    // Check if authorities specify threshold
    if (data?.authorities && Array.isArray(data.authorities)) {
      return data.authorities.length;
    }
    return 1;
  }

  /**
   * Extract token symbol from token URL
   */
  private extractTokenSymbol(tokenUrl: string): string {
    // Extract symbol from URL like "acc://ACME" or "acc://myadi.acme/tokens/USDC"
    const parts = tokenUrl.split('/');
    const last = parts[parts.length - 1];
    // Handle acc://ACME case
    if (parts.length === 3 && parts[0] === 'acc:' && parts[1] === '') {
      return last.toUpperCase();
    }
    return last.toUpperCase();
  }

  /**
   * Determine transaction status based on signatures
   */
  private determineStatus(
    collected: number,
    required: number
  ): 'pending' | 'awaiting_signatures' | 'partially_signed' {
    if (collected === 0) {
      return 'pending';
    }
    if (collected < required) {
      return 'partially_signed';
    }
    return 'awaiting_signatures';
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
   * Calculate urgency level based on time remaining
   */
  private calculateUrgency(timeRemaining: number): 'normal' | 'warning' | 'critical' {
    if (timeRemaining < 4 * 60 * 60 * 1000) return 'critical'; // < 4 hours
    if (timeRemaining < 24 * 60 * 60 * 1000) return 'warning'; // < 24 hours
    return 'normal';
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

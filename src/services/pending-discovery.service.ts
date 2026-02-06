/**
 * Pending Discovery Service
 *
 * Core algorithm for discovering pending transactions that a user can sign.
 * Implements a dual-phase algorithm aligned with the Dart service.
 */

import { AccumulateClient } from '../clients/accumulate.client';
import { AppConfig } from '../config';
import {
  CertenUserWithAdis,
  CertenAdi,
  AccumulatePendingTx,
  AccumulateSignature,
  SigningPath,
  DiscoveryResult,
  EligibleTransaction,
} from '../types';
import { normalizeUrl, extractAdiFromUrl } from '../utils/url-normalizer';
import { normalizeHash, normalizePublicKeyHash } from '../utils/hash-normalizer';
import { logger } from '../utils/logger';

export class PendingDiscoveryService {
  private readonly accumulate: AccumulateClient;
  private readonly pendingPageSize: number;

  constructor(accumulate: AccumulateClient, config: AppConfig) {
    this.accumulate = accumulate;
    this.pendingPageSize = config.pendingPageSize;
  }

  /**
   * DUAL-PHASE ALGORITHM (aligned with Dart service)
   *
   * Phase 1: Signing Path Processing
   *   For each user's signing path (A -> B -> C):
   *   - Query pending transactions for final signer (C)
   *   - Check if prior hop (B) has signed
   *   - Include if prior hop has NOT signed
   *
   * Phase 2: User Account Processing
   *   For each ADI account (book, tokens, staking, data):
   *   - Query pending transactions
   *   - Check if user's primary signer has signed
   *   - Include if user has NOT signed
   *
   * Phase 3: Deduplication
   *   - Combine results from both phases
   *   - Deduplicate by transaction hash
   *   - Return unique eligible transactions
   */
  async discoverPendingForUser(
    user: CertenUserWithAdis,
    signingPaths: SigningPath[]
  ): Promise<DiscoveryResult> {
    const eligibleTxs = new Map<string, EligibleTransaction>();
    const allSignatures = new Map<string, AccumulateSignature[]>();

    // Get all user's public key hashes for signature matching
    const userKeyHashes = this.extractUserKeyHashes(user);

    logger.info('Starting pending discovery', {
      uid: user.uid.substring(0, 8),
      adiCount: user.adis.length,
      pathCount: signingPaths.length,
      keyHashCount: userKeyHashes.size,
    });

    // PHASE 1: Process signing paths (delegation chains)
    await this.processSigningPaths(
      signingPaths,
      userKeyHashes,
      eligibleTxs,
      allSignatures
    );

    // PHASE 2: Process user accounts
    await this.processUserAccounts(
      user,
      userKeyHashes,
      eligibleTxs,
      allSignatures
    );

    // PHASE 3: Build final result (deduplication already handled by Map)
    const result: DiscoveryResult = {
      eligibleTransactions: Array.from(eligibleTxs.values()),
      totalCount: eligibleTxs.size,
      signatures: allSignatures,
    };

    logger.info('Discovery completed', {
      uid: user.uid.substring(0, 8),
      eligibleCount: result.totalCount,
    });

    return result;
  }

  /**
   * Phase 1: Process signing paths for delegated pending transactions
   */
  private async processSigningPaths(
    signingPaths: SigningPath[],
    userKeyHashes: Set<string>,
    eligibleTxs: Map<string, EligibleTransaction>,
    allSignatures: Map<string, AccumulateSignature[]>
  ): Promise<void> {
    for (const signingPath of signingPaths) {
      // Skip single-hop paths (direct signers) - they're handled in Phase 2
      if (signingPath.hops.length < 2) {
        continue;
      }

      const finalSigner = signingPath.finalSigner;
      const priorHop = signingPath.hops[signingPath.hops.length - 2];

      try {
        // Query pending for final signer
        const pendingTxs = await this.accumulate.queryPending(finalSigner, {
          count: this.pendingPageSize,
        });

        logger.info('Phase 1: queried finalSigner for pending', {
          finalSigner,
          path: signingPath.path,
          pendingCount: pendingTxs.length,
        });

        for (const tx of pendingTxs) {
          const normalizedHash = normalizeHash(tx.hash);

          // Cache signatures
          if (!allSignatures.has(normalizedHash)) {
            allSignatures.set(normalizedHash, tx.signatures);
          }

          // Check if prior hop has signed
          const priorHopSigned = tx.signatures.some(
            sig => normalizeUrl(sig.signer) === normalizeUrl(priorHop)
          );

          if (!priorHopSigned) {
            // Prior hop hasn't signed - eligible for this path
            this.addEligibleTx(
              eligibleTxs,
              tx,
              signingPath.path,
              'requiring_signature'
            );
          }
        }
      } catch (error) {
        logger.warn('Failed to process signing path', {
          path: signingPath.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Phase 2: Process user accounts for direct pending transactions
   */
  private async processUserAccounts(
    user: CertenUserWithAdis,
    userKeyHashes: Set<string>,
    eligibleTxs: Map<string, EligibleTransaction>,
    allSignatures: Map<string, AccumulateSignature[]>
  ): Promise<void> {
    for (const adi of user.adis) {
      // Discover all accounts under ADI
      const accounts = await this.discoverAdiAccounts(adi);

      for (const accountUrl of accounts) {
        try {
          const pendingTxs = await this.accumulate.queryPending(accountUrl, {
            count: this.pendingPageSize,
          });

          if (pendingTxs.length > 0) {
            logger.info('Phase 2: found pending txs on account', {
              accountUrl,
              pendingCount: pendingTxs.length,
            });
          }

          for (const tx of pendingTxs) {
            const normalizedHash = normalizeHash(tx.hash);

            // Cache signatures
            if (!allSignatures.has(normalizedHash)) {
              allSignatures.set(normalizedHash, tx.signatures);
            }

            // Check if user has signed with any of their keys
            const userHasSigned = this.hasUserSigned(tx.signatures, userKeyHashes);

            if (!userHasSigned) {
              // User hasn't signed - determine category
              const category = this.determineCategory(tx, adi.adiUrl);
              this.addEligibleTx(eligibleTxs, tx, adi.adiUrl, category);
            }
          }
        } catch (error) {
          logger.warn('Failed to query pending for account', {
            accountUrl,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Extract all public key hashes from user's ADIs
   */
  private extractUserKeyHashes(user: CertenUserWithAdis): Set<string> {
    const hashes = new Set<string>();

    for (const adi of user.adis) {
      for (const keyBook of adi.keyBooks || []) {
        for (const keyPage of keyBook.keyPages || []) {
          for (const entry of keyPage.entries || []) {
            if (entry.type === 'key' && entry.publicKeyHash) {
              hashes.add(normalizePublicKeyHash(entry.publicKeyHash));
            }
          }
        }
      }
    }

    return hashes;
  }

  /**
   * Check if user has signed a transaction
   */
  private hasUserSigned(
    signatures: AccumulateSignature[],
    userKeyHashes: Set<string>
  ): boolean {
    for (const sig of signatures) {
      if (userKeyHashes.has(normalizePublicKeyHash(sig.publicKeyHash))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Discover all accounts under an ADI
   */
  private async discoverAdiAccounts(adi: CertenAdi): Promise<string[]> {
    const accounts: string[] = [normalizeUrl(adi.adiUrl)];

    // Add accounts from stored ADI data
    for (const account of adi.accounts || []) {
      accounts.push(normalizeUrl(account.url));
    }

    // Add key books and key pages
    for (const keyBook of adi.keyBooks || []) {
      accounts.push(normalizeUrl(keyBook.url));
      for (const keyPage of keyBook.keyPages || []) {
        accounts.push(normalizeUrl(keyPage.url));
      }
    }

    // Try to query directory for any accounts we might have missed
    const directory = await this.accumulate.queryDirectory(adi.adiUrl, {
      count: 100,
    });

    if (directory.length > 0) {
      logger.info('Directory query returned entries', {
        adiUrl: adi.adiUrl,
        directoryCount: directory.length,
        entries: directory,
      });
      for (const entry of directory) {
        const normalized = normalizeUrl(entry);
        if (!accounts.includes(normalized)) {
          accounts.push(normalized);
        }
      }
    } else {
      logger.warn('Directory query returned empty for ADI', {
        adiUrl: adi.adiUrl,
      });
    }

    logger.info('Discovered ADI accounts', {
      adiUrl: adi.adiUrl,
      accountCount: accounts.length,
      accounts,
    });

    return accounts;
  }

  /**
   * Determine the category for a pending transaction
   */
  private determineCategory(
    tx: AccumulatePendingTx,
    adiUrl: string
  ): 'initiated_by_user' | 'requiring_signature' {
    // Check if transaction principal is under user's ADI
    const txAdi = extractAdiFromUrl(tx.principal);
    const userAdi = normalizeUrl(adiUrl);

    if (txAdi === userAdi) {
      return 'initiated_by_user';
    }

    return 'requiring_signature';
  }

  /**
   * Add an eligible transaction to the map (handles deduplication)
   */
  private addEligibleTx(
    map: Map<string, EligibleTransaction>,
    tx: AccumulatePendingTx,
    signingPath: string,
    category: 'initiated_by_user' | 'requiring_signature'
  ): void {
    const hash = normalizeHash(tx.hash);

    if (!map.has(hash)) {
      map.set(hash, {
        tx,
        eligiblePaths: [signingPath],
        category,
      });
    } else {
      const existing = map.get(hash)!;
      if (!existing.eligiblePaths.includes(signingPath)) {
        existing.eligiblePaths.push(signingPath);
      }
      // Keep the more privileged category (initiated > requiring)
      if (category === 'initiated_by_user') {
        existing.category = 'initiated_by_user';
      }
    }
  }
}

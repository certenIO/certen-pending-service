/**
 * Pending Discovery Service
 *
 * Core algorithm for discovering pending transactions that a user can sign.
 * Implements a three-phase algorithm aligned with the Dart service.
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
   * THREE-PHASE ALGORITHM (aligned with Dart service)
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
   * Phase 3: Signature Chain Scan
   *   For each key book:
   *   - Scan last N entries of signature chain
   *   - Find signatureRequest messages
   *   - Extract produced txIDs and verify still pending
   *   - Catches transactions missed by Phases 1-2
   *
   * Phase 4: Deduplication
   *   - Combine results from all phases
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

    // PHASE 3: Signature chain scan
    const seenHashes = new Set(eligibleTxs.keys());
    await this.scanSignatureChains(
      user,
      userKeyHashes,
      seenHashes,
      eligibleTxs,
      allSignatures
    );

    // PHASE 4: Build final result (deduplication already handled by Map)
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
   * Phase 3: Scan key book signature chains for signatureRequest messages.
   * Catches pending transactions missed by Phases 1-2 (e.g. cross-ADI requests).
   */
  private async scanSignatureChains(
    user: CertenUserWithAdis,
    userKeyHashes: Set<string>,
    seenHashes: Set<string>,
    eligibleTxs: Map<string, EligibleTransaction>,
    allSignatures: Map<string, AccumulateSignature[]>
  ): Promise<void> {
    const maxEntries = 30;

    for (const adi of user.adis) {
      // Collect key book URLs
      const keyBookUrls = new Set<string>();
      for (const keyBook of adi.keyBooks || []) {
        keyBookUrls.add(normalizeUrl(keyBook.url));
      }
      // Also check directory for key books
      const directory = await this.accumulate.queryDirectory(adi.adiUrl, { count: 100 });
      for (const entry of directory) {
        keyBookUrls.add(normalizeUrl(entry));
      }

      for (const bookUrl of keyBookUrls) {
        try {
          // Get total signature chain length
          const { total } = await this.accumulate.querySignatureChain(bookUrl, {
            start: 0, count: 1, expand: false,
          });

          if (total === 0) continue;

          // Query last N entries (most recent)
          const startIndex = total > maxEntries ? total - maxEntries : 0;
          const count = total > maxEntries ? maxEntries : total;

          const { records } = await this.accumulate.querySignatureChain(bookUrl, {
            start: startIndex, count, expand: true,
          });

          let sigReqCount = 0;
          let foundPending = 0;

          for (const rec of records) {
            if (typeof rec !== 'object' || rec === null) continue;
            const recMap = rec as Record<string, unknown>;
            const value = (recMap.value || recMap) as Record<string, unknown>;
            const message = (value.message || {}) as Record<string, unknown>;
            const msgType = String(message.type || '');

            if (msgType !== 'signatureRequest') continue;
            sigReqCount++;

            // Extract produced transaction IDs
            const produced = (value.produced || {}) as Record<string, unknown>;
            const producedRecords = (produced.records || []) as unknown[];

            for (const prodRec of producedRecords) {
              if (typeof prodRec !== 'object' || prodRec === null) continue;
              const prodMap = prodRec as Record<string, unknown>;
              const prodTxId = String(prodMap.value || prodMap.id || '');
              if (!prodTxId) continue;

              const txHash = normalizeHash(prodTxId);
              if (!txHash || seenHashes.has(txHash)) continue;
              seenHashes.add(txHash);

              // Query this transaction to check if still pending
              const txRaw = await this.accumulate.queryTransactionRaw(prodTxId);
              if (!txRaw) continue;

              const status = this.extractStatus(txRaw);
              if (status !== 'pending') continue;

              // It's pending — fetch full details
              const txDetails = await this.accumulate.queryTransaction(prodTxId);
              if (!txDetails) continue;

              foundPending++;

              // Check if user has already signed
              const userHasSigned = this.hasUserSigned(txDetails.signatures, userKeyHashes);
              if (!userHasSigned) {
                this.addEligibleTx(eligibleTxs, txDetails, bookUrl, 'requiring_signature');

                if (!allSignatures.has(txHash)) {
                  allSignatures.set(txHash, txDetails.signatures);
                }
              }
            }
          }

          if (sigReqCount > 0) {
            logger.info('Phase 3: scanned signature chain', {
              bookUrl,
              total,
              sigReqCount,
              foundPending,
            });
          }
        } catch (error) {
          logger.warn('Failed to scan signature chain', {
            bookUrl,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Extract status string from raw v3 transaction response.
   */
  private extractStatus(txRaw: Record<string, unknown>): string {
    const statusField = txRaw.status;
    if (typeof statusField === 'string') return statusField.toLowerCase();
    if (typeof statusField === 'object' && statusField !== null) {
      const s = statusField as Record<string, unknown>;
      const code = s.code;
      if (typeof code === 'number') return code === 202 ? 'pending' : code === 201 ? 'delivered' : 'other';
      if (typeof code === 'string') return code.toLowerCase();
      if (s.pending === true) return 'pending';
      if (s.delivered === true) return 'delivered';
    }
    return 'unknown';
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
    const accountSet = new Set<string>();
    const addAccount = (url: string) => accountSet.add(normalizeUrl(url));
    const keyBookUrls = new Set<string>();

    // Start with the ADI itself
    addAccount(adi.adiUrl);

    // Add accounts from stored ADI data
    for (const account of adi.accounts || []) {
      addAccount(account.url);
    }

    // Add key books from Firestore
    for (const keyBook of adi.keyBooks || []) {
      const bookUrl = normalizeUrl(keyBook.url);
      addAccount(bookUrl);
      keyBookUrls.add(bookUrl);
    }

    // Query ADI directory for accounts we might have missed
    const directory = await this.accumulate.queryDirectory(adi.adiUrl, {
      count: 100,
    });

    for (const entry of directory) {
      addAccount(entry);
    }

    // For each key book, query Accumulate for page count and enumerate key pages
    // Include key books found via directory (not just Firestore)
    for (const entry of directory) {
      // Directory may contain key books not in Firestore — we'll query all
      // non-page entries to check page count
      const normalized = normalizeUrl(entry);
      if (!keyBookUrls.has(normalized)) {
        keyBookUrls.add(normalized);
      }
    }

    for (const bookUrl of keyBookUrls) {
      const pageCount = await this.accumulate.queryKeyBookPageCount(bookUrl);
      for (let i = 1; i <= pageCount; i++) {
        addAccount(`${bookUrl}/${i}`);
      }
    }

    const accounts = Array.from(accountSet);

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

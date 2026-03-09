/**
 * Signing Path Service
 *
 * Discovers all signing paths for a user by scanning their key pages
 * for delegate entries and recursively following delegation chains.
 *
 * Fixes applied:
 * - G-2: Delegate-to-book resolution — enumerate all pages under a key book
 * - G-3: Per-chain visited set — clone visited set at branch points
 * - Structured hop metadata — capture threshold/entry counts per hop
 */

import { AccumulateClient } from '../clients/accumulate.client';
import { AppConfig } from '../config';
import { CertenAdi, CertenKeyBook, CertenKeyEntry, CertenKeyPage, SigningPath, SigningPathHop } from '../types';
import { normalizeUrl } from '../utils/url-normalizer';
import { logger } from '../utils/logger';

export interface SigningPathDiscoveryResult {
  paths: SigningPath[];
  discoveredKeyBooks: CertenKeyBook[];
}

/** Key page data returned from Accumulate queries */
interface AccumulateKeyPageData {
  url: string;
  version: number;
  threshold: number;
  creditBalance: number;
  keys: { publicKeyHash: string; keyType?: string; delegate?: string }[];
}

export class SigningPathService {
  private readonly accumulate: AccumulateClient;
  private readonly maxDepth: number;

  constructor(accumulate: AccumulateClient, config: AppConfig) {
    this.accumulate = accumulate;
    this.maxDepth = config.delegationDepth;
  }

  /**
   * Discover all signing paths for a user by scanning their key pages
   * for delegate entries and recursively following them.
   *
   * Algorithm:
   * 1. Start at user's primary key pages
   * 2. Add direct key pages as single-hop paths
   * 3. For each delegate entry, follow the delegation chain (with per-chain visited set)
   * 4. When a delegate points to a key book, enumerate all pages under it
   * 5. Return validated paths up to maxDepth (protocol limit: 20)
   */
  async discoverSigningPaths(userAdi: CertenAdi): Promise<SigningPathDiscoveryResult> {
    const paths: SigningPath[] = [];
    const processedPages = new Set<string>();

    // Collect all key book URLs from Firestore
    const keyBookUrls = new Set<string>();
    for (const keyBook of userAdi.keyBooks || []) {
      keyBookUrls.add(normalizeUrl(keyBook.url));
    }

    // Discover additional key books from ADI directory
    const directory = await this.accumulate.queryDirectory(userAdi.adiUrl, { count: 100 });
    for (const entry of directory) {
      keyBookUrls.add(normalizeUrl(entry));
    }

    // Process Firestore key pages first (already have delegate entries)
    for (const keyBook of userAdi.keyBooks || []) {
      const bookUrl = normalizeUrl(keyBook.url);
      for (const keyPage of keyBook.keyPages || []) {
        const pageUrl = normalizeUrl(keyPage.url);
        if (processedPages.has(pageUrl)) continue;
        processedPages.add(pageUrl);

        const hop = this.buildHopFromCertenKeyPage(keyPage, bookUrl, userAdi.adiUrl);

        paths.push({
          path: pageUrl,
          hops: [pageUrl],
          structuredHops: [hop],
          finalSigner: pageUrl,
          directPath: true,
          depth: 1,
          discoveredAt: new Date(),
        });

        const delegates = this.extractDelegates(keyPage);
        for (const delegateUrl of delegates) {
          // G-3: Fresh visited set per delegation chain
          const visited = new Set<string>([pageUrl]);
          await this.followDelegationChain(
            pageUrl, delegateUrl, [pageUrl], [hop], visited, paths, 1
          );
        }
      }
    }

    // Query each key book for page count — build discovered key books and find new pages
    const discoveredKeyBooks: CertenKeyBook[] = [];
    for (const bookUrl of keyBookUrls) {
      const pageCount = await this.accumulate.queryKeyBookPageCount(bookUrl);
      if (pageCount === 0) continue; // not a key book (data account, ADI, etc.)

      const discoveredPages: CertenKeyPage[] = [];
      for (let i = 1; i <= pageCount; i++) {
        const pageUrl = normalizeUrl(`${bookUrl}/${i}`);

        // Always query Accumulate for latest key page state
        const keyPageData = await this.accumulate.queryKeyPage(pageUrl);
        if (keyPageData) {
          discoveredPages.push(this.toFirestoreKeyPage(keyPageData));
        }

        // Only add as signing path if not already processed from Firestore loop
        if (!processedPages.has(pageUrl)) {
          processedPages.add(pageUrl);

          const hop = keyPageData
            ? this.buildHopFromAccumulateData(keyPageData, bookUrl, userAdi.adiUrl, false)
            : this.buildUnknownHop(pageUrl, bookUrl, userAdi.adiUrl, false);

          paths.push({
            path: pageUrl,
            hops: [pageUrl],
            structuredHops: [hop],
            finalSigner: pageUrl,
            directPath: true,
            depth: 1,
            discoveredAt: new Date(),
          });

          if (keyPageData?.keys) {
            const delegates = keyPageData.keys.filter(k => k.delegate).map(k => normalizeUrl(k.delegate!));
            for (const delegateUrl of delegates) {
              // G-3: Fresh visited set per delegation chain
              const visited = new Set<string>([pageUrl]);
              await this.followDelegationChain(
                pageUrl, delegateUrl, [pageUrl], [hop], visited, paths, 1
              );
            }
          }
        }
      }

      discoveredKeyBooks.push({ url: bookUrl, keyPages: discoveredPages });
    }

    return { paths, discoveredKeyBooks };
  }

  /**
   * Convert AccumulateKeyPage to CertenKeyPage for Firestore storage.
   * Avoids undefined values which Firestore rejects.
   */
  private toFirestoreKeyPage(akp: AccumulateKeyPageData): CertenKeyPage {
    const entries: CertenKeyEntry[] = akp.keys.map(k => {
      const entry: CertenKeyEntry = { type: k.delegate ? 'delegate' : 'key' } as CertenKeyEntry;
      if (k.publicKeyHash) entry.publicKeyHash = k.publicKeyHash;
      if (k.keyType) entry.keyType = k.keyType;
      if (k.delegate) entry.delegateUrl = k.delegate;
      return entry;
    });

    return {
      url: akp.url,
      version: akp.version,
      threshold: akp.threshold,
      creditBalance: akp.creditBalance,
      entries,
    };
  }

  /**
   * Extract delegate URLs from a key page
   */
  private extractDelegates(keyPage: CertenKeyPage): string[] {
    const delegates: string[] = [];

    for (const entry of keyPage.entries || []) {
      if (entry.type === 'delegate' && entry.delegateUrl) {
        delegates.push(normalizeUrl(entry.delegateUrl));
      }
    }

    return delegates;
  }

  /**
   * Build a SigningPathHop from a CertenKeyPage (Firestore data)
   */
  private buildHopFromCertenKeyPage(keyPage: CertenKeyPage, keyBookUrl: string, adiUrl: string): SigningPathHop {
    return {
      url: normalizeUrl(keyPage.url),
      keyBookUrl: normalizeUrl(keyBookUrl),
      adiUrl,
      threshold: keyPage.acceptThreshold ?? keyPage.threshold ?? 1,
      totalEntries: (keyPage.entries || []).length,
      isDelegateHop: false,
    };
  }

  /**
   * Build a SigningPathHop from Accumulate query data
   */
  private buildHopFromAccumulateData(
    data: AccumulateKeyPageData,
    keyBookUrl: string,
    adiUrl: string,
    isDelegateHop: boolean
  ): SigningPathHop {
    return {
      url: normalizeUrl(data.url),
      keyBookUrl: normalizeUrl(keyBookUrl),
      adiUrl,
      threshold: data.threshold ?? 1,
      totalEntries: (data.keys || []).length,
      isDelegateHop,
    };
  }

  /**
   * Build a hop with unknown metadata (when query fails)
   */
  private buildUnknownHop(pageUrl: string, keyBookUrl: string, adiUrl: string, isDelegateHop: boolean): SigningPathHop {
    return {
      url: normalizeUrl(pageUrl),
      keyBookUrl: normalizeUrl(keyBookUrl),
      adiUrl,
      threshold: 0,
      totalEntries: 0,
      isDelegateHop,
    };
  }

  /**
   * Extract ADI URL from a key page or key book URL.
   * e.g. "acc://alice.acme/book/1" -> "acc://alice.acme"
   */
  private extractAdiUrl(url: string): string {
    const match = url.match(/^(acc:\/\/[^/]+)/);
    return match ? match[1] : url;
  }

  /**
   * Extract key book URL from a key page URL.
   * e.g. "acc://alice.acme/book/1" -> "acc://alice.acme/book"
   */
  private extractKeyBookUrl(pageUrl: string): string {
    // Remove trailing page index
    const match = pageUrl.match(/^(.+)\/\d+$/);
    return match ? match[1] : pageUrl;
  }

  /**
   * Recursively follow a delegation chain.
   *
   * G-2 fix: When a delegate target is a key book (not a key page), enumerate
   * all pages under the book and create separate paths for each.
   *
   * G-3 fix: Each chain gets its own visited set (cloned at branch points)
   * so that parallel paths through the same intermediate book are all discovered.
   */
  private async followDelegationChain(
    sourceUrl: string,
    targetUrl: string,
    currentPath: string[],
    currentHops: SigningPathHop[],
    visited: Set<string>,
    results: SigningPath[],
    depth: number
  ): Promise<void> {
    const normalizedTarget = normalizeUrl(targetUrl);
    if (visited.has(normalizedTarget) || depth > this.maxDepth) {
      return;
    }
    visited.add(normalizedTarget);

    // Verify target exists
    const exists = await this.accumulate.accountExists(normalizedTarget);
    if (!exists) {
      logger.debug('Delegate target does not exist', {
        source: sourceUrl,
        target: normalizedTarget,
      });
      return;
    }

    // G-2: Check if target is a key book by querying page count
    const pageCount = await this.accumulate.queryKeyBookPageCount(normalizedTarget);

    if (pageCount > 0) {
      // Target is a key book — enumerate all pages under it
      const targetAdiUrl = this.extractAdiUrl(normalizedTarget);

      for (let i = 1; i <= pageCount; i++) {
        const pageUrl = normalizeUrl(`${normalizedTarget}/${i}`);
        if (visited.has(pageUrl)) continue;

        // G-3: Clone visited set for each branch
        const branchVisited = new Set(visited);
        branchVisited.add(pageUrl);

        // Query the key page for metadata and delegates
        try {
          const keyPageData = await this.accumulate.queryKeyPage(pageUrl);
          const hop = keyPageData
            ? this.buildHopFromAccumulateData(keyPageData, normalizedTarget, targetAdiUrl, true)
            : this.buildUnknownHop(pageUrl, normalizedTarget, targetAdiUrl, true);

          const newPath = [...currentPath, pageUrl];
          const newHops = [...currentHops, hop];
          const pathString = newPath.join(' -> ');

          results.push({
            path: pathString,
            hops: newPath,
            structuredHops: newHops,
            finalSigner: pageUrl,
            directPath: false,
            depth: newPath.length,
            discoveredAt: new Date(),
          });

          // Continue following delegates from this page
          if (keyPageData?.keys) {
            const newDelegates = keyPageData.keys
              .filter(k => k.delegate)
              .map(k => normalizeUrl(k.delegate!));

            for (const delegate of newDelegates) {
              await this.followDelegationChain(
                pageUrl, delegate, newPath, newHops, branchVisited, results, depth + 1
              );
            }
          }
        } catch (error) {
          logger.debug('Could not read delegate key page under book', {
            book: normalizedTarget,
            page: pageUrl,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      // Target is a key page (or non-book account) — original behavior
      const targetAdiUrl = this.extractAdiUrl(normalizedTarget);
      const targetBookUrl = this.extractKeyBookUrl(normalizedTarget);

      try {
        const keyPageData = await this.accumulate.queryKeyPage(normalizedTarget);
        const hop = keyPageData
          ? this.buildHopFromAccumulateData(keyPageData, targetBookUrl, targetAdiUrl, true)
          : this.buildUnknownHop(normalizedTarget, targetBookUrl, targetAdiUrl, true);

        const newPath = [...currentPath, normalizedTarget];
        const newHops = [...currentHops, hop];
        const pathString = newPath.join(' -> ');

        results.push({
          path: pathString,
          hops: newPath,
          structuredHops: newHops,
          finalSigner: normalizedTarget,
          directPath: false,
          depth: newPath.length,
          discoveredAt: new Date(),
        });

        // Continue following delegates
        if (keyPageData?.keys) {
          const newDelegates = keyPageData.keys
            .filter(k => k.delegate)
            .map(k => normalizeUrl(k.delegate!));

          for (const delegate of newDelegates) {
            // G-3: Clone visited set for each branch
            const branchVisited = new Set(visited);
            await this.followDelegationChain(
              normalizedTarget, delegate, newPath, newHops, branchVisited, results, depth + 1
            );
          }
        }
      } catch (error) {
        // Log but continue - target may not have accessible key data
        logger.debug('Could not read delegate key page', {
          target: normalizedTarget,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Get all unique final signers from signing paths
   */
  getUniqueSigners(paths: SigningPath[]): string[] {
    const signers = new Set<string>();
    for (const path of paths) {
      signers.add(path.finalSigner);
    }
    return Array.from(signers);
  }

  /**
   * Find paths that can sign for a specific signer
   */
  findPathsForSigner(paths: SigningPath[], signerUrl: string): SigningPath[] {
    const normalized = normalizeUrl(signerUrl);
    return paths.filter(p => p.finalSigner === normalized);
  }

  /**
   * Check if a signing path includes a specific hop
   */
  pathIncludesHop(path: SigningPath, hopUrl: string): boolean {
    const normalized = normalizeUrl(hopUrl);
    return path.hops.includes(normalized);
  }
}

/**
 * Signing Path Service
 *
 * Discovers all signing paths for a user by scanning their key pages
 * for delegate entries and recursively following delegation chains.
 */

import { AccumulateClient } from '../clients/accumulate.client';
import { AppConfig } from '../config';
import { CertenAdi, CertenKeyPage, SigningPath } from '../types';
import { normalizeUrl } from '../utils/url-normalizer';
import { logger } from '../utils/logger';

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
   * Algorithm (aligned with Dart service):
   * 1. Start at user's primary key page: acc://username.acme/book/1
   * 2. Add direct key pages as paths
   * 3. For each delegate entry, follow the delegation chain
   * 4. Return validated paths up to maxDepth
   */
  async discoverSigningPaths(userAdi: CertenAdi): Promise<SigningPath[]> {
    const paths: SigningPath[] = [];
    const visited = new Set<string>();

    // Process each key book in user's ADI
    for (const keyBook of userAdi.keyBooks || []) {
      for (const keyPage of keyBook.keyPages || []) {
        // Add the direct key page as a path (single hop)
        paths.push({
          path: keyPage.url,
          hops: [normalizeUrl(keyPage.url)],
          finalSigner: normalizeUrl(keyPage.url),
          discoveredAt: new Date(),
        });

        // Find delegate entries and follow them
        const delegates = this.extractDelegates(keyPage);

        for (const delegateUrl of delegates) {
          await this.followDelegationChain(
            normalizeUrl(keyPage.url),
            delegateUrl,
            [normalizeUrl(keyPage.url)],
            visited,
            paths,
            1
          );
        }
      }
    }

    logger.debug('Discovered signing paths', {
      adiUrl: userAdi.adiUrl,
      pathCount: paths.length,
    });

    return paths;
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
   * Recursively follow a delegation chain
   */
  private async followDelegationChain(
    sourceUrl: string,
    targetUrl: string,
    currentPath: string[],
    visited: Set<string>,
    results: SigningPath[],
    depth: number
  ): Promise<void> {
    // Prevent infinite loops and excessive depth
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

    // Build new path
    const newPath = [...currentPath, normalizedTarget];
    const pathString = newPath.join(' -> ');

    results.push({
      path: pathString,
      hops: newPath,
      finalSigner: normalizedTarget,
      discoveredAt: new Date(),
    });

    // Try to get the key page to find more delegates
    try {
      const keyPageData = await this.accumulate.queryKeyPage(normalizedTarget);
      if (keyPageData && keyPageData.keys) {
        // Find delegates in this key page
        const newDelegates = keyPageData.keys
          .filter(k => k.delegate)
          .map(k => normalizeUrl(k.delegate!));

        for (const delegate of newDelegates) {
          await this.followDelegationChain(
            normalizedTarget,
            delegate,
            newPath,
            visited,
            results,
            depth + 1
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

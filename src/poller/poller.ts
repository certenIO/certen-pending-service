/**
 * Pending Actions Poller
 *
 * Main polling loop that periodically scans for pending transactions
 * and updates Firestore for all users.
 */

import { AccumulateClient } from '../clients/accumulate.client';
import { FirestoreClient } from '../clients/firestore.client';
import { SigningPathService } from '../services/signing-path.service';
import { PendingDiscoveryService } from '../services/pending-discovery.service';
import { StateManagerService } from '../services/state-manager.service';
import { AppConfig } from '../config';
import { CertenUserWithAdis, CertenKeyBook, SigningPath, FirestoreSigningPath, PollStats, createPollStats } from '../types';
import { Semaphore } from '../utils/retry';
import {
  logger,
  logPollStart,
  logPollComplete,
  logUserContext,
  logDiscoveryResult,
} from '../utils/logger';

export class PendingActionsPoller {
  private readonly config: AppConfig;
  private readonly accumulate: AccumulateClient;
  private readonly firestore: FirestoreClient;
  private readonly signingPathService: SigningPathService;
  private readonly discoveryService: PendingDiscoveryService;
  private readonly stateManager: StateManagerService;

  private isRunning = false;
  private isTicking = false;
  private pollTimer: NodeJS.Timeout | null = null;

  // Health/heartbeat state (read by the health server).
  private lastSuccessfulTickAt: number | null = null;
  private tickStartedAt: number | null = null;
  private lastStats: PollStats | null = null;
  private lastError: string | null = null;

  constructor(config: AppConfig) {
    this.config = config;

    // Initialize clients
    this.accumulate = new AccumulateClient(config);
    this.firestore = new FirestoreClient(config);

    // Initialize services
    this.signingPathService = new SigningPathService(this.accumulate, config);
    this.discoveryService = new PendingDiscoveryService(this.accumulate, config);
    this.stateManager = new StateManagerService(this.firestore, config);
  }

  /**
   * Start the polling loop
   */
  async start(): Promise<void> {
    logger.info('Starting Certen Pending Actions Poller', {
      pollInterval: this.config.pollIntervalSec,
      concurrency: this.config.userConcurrency,
      accumulateUrl: this.config.accumulateApiUrl,
      network: this.config.accumulateNetwork,
      dryRun: this.config.dryRun,
    });

    this.isRunning = true;

    // Register shutdown handlers BEFORE the first tick so a SIGTERM during the
    // (write-heavy, cold-cache) initial cycle is handled gracefully rather than
    // killing the process mid-commit.
    this.setupShutdownHandlers();

    // Initial poll
    await this.tick();

    // Schedule periodic polls
    this.pollTimer = setInterval(
      () => this.tick(),
      this.config.pollIntervalSec * 1000
    );
  }

  /**
   * Execute a single poll cycle
   */
  async tick(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Re-entrancy guard: if a previous cycle is still running (e.g. it took
    // longer than pollIntervalSec), skip this tick rather than running two
    // overlapping cycles that double the Firestore/Accumulate load and can
    // race on the same users' state.
    if (this.isTicking) {
      logger.warn('Skipping poll cycle — previous cycle still running (consider a longer pollIntervalSec)');
      return;
    }
    this.isTicking = true;
    this.tickStartedAt = Date.now();

    const startTime = Date.now();
    const stats = createPollStats();

    logPollStart();

    // Enable the Accumulate per-cycle read cache for the duration of this tick
    // so duplicate idempotent reads (directory/keypage/tx) are coalesced.
    this.accumulate.beginCycle();

    try {
      // Fetch all users with ADIs
      const users = await this.firestore.listUsersWithAdis();
      stats.totalUsers = users.length;

      logger.info(`Found ${users.length} users to process`);

      // Process users with concurrency limit
      const semaphore = new Semaphore(this.config.userConcurrency);

      await Promise.all(
        users.map(user =>
          this.processUserWithSemaphore(user, stats, semaphore)
        )
      );

      stats.duration = Date.now() - startTime;
      logPollComplete(stats);

      // Heartbeat: record a successful cycle for the health endpoint.
      this.lastSuccessfulTickAt = Date.now();
      this.lastStats = stats;
      this.lastError = null;

      // Alarmable signal: surface failed/degraded users as an error-level line
      // so an operator (or log-based alert) notices, instead of it hiding in
      // per-user warnings.
      if (stats.failedUsers > 0 || stats.degradedUsers > 0) {
        logger.error('Poll cycle completed with failures/degradation', {
          totalUsers: stats.totalUsers,
          failedUsers: stats.failedUsers,
          degradedUsers: stats.degradedUsers,
        });
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.error('Poll cycle failed', {
        error: this.lastError,
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.accumulate.endCycle();
      this.isTicking = false;
      this.tickStartedAt = null;
    }
  }

  /**
   * Health snapshot for the heartbeat server. Reports unhealthy if no cycle has
   * succeeded within 3 poll intervals (stale) or a single tick has been running
   * that long (wedged) — either way the orchestrator should restart us.
   */
  getHealthSnapshot(): {
    healthy: boolean;
    isRunning: boolean;
    isTicking: boolean;
    lastSuccessfulTickAt: number | null;
    secondsSinceLastSuccess: number | null;
    tickRunningMs: number;
    stale: boolean;
    stuck: boolean;
    lastError: string | null;
    lastStats: PollStats | null;
  } {
    const now = Date.now();
    const staleAfterMs = this.config.pollIntervalSec * 1000 * 3;
    const secondsSinceLastSuccess =
      this.lastSuccessfulTickAt === null ? null : Math.floor((now - this.lastSuccessfulTickAt) / 1000);
    // Before the first cycle completes we're "starting", not stale.
    const stale =
      this.lastSuccessfulTickAt !== null && now - this.lastSuccessfulTickAt > staleAfterMs;
    const tickRunningMs = this.tickStartedAt ? now - this.tickStartedAt : 0;
    const stuck = tickRunningMs > staleAfterMs;
    return {
      healthy: this.isRunning && !stale && !stuck,
      isRunning: this.isRunning,
      isTicking: this.isTicking,
      lastSuccessfulTickAt: this.lastSuccessfulTickAt,
      secondsSinceLastSuccess,
      tickRunningMs,
      stale,
      stuck,
      lastError: this.lastError,
      lastStats: this.lastStats,
    };
  }

  /**
   * Process a user with semaphore for concurrency control
   */
  private async processUserWithSemaphore(
    user: CertenUserWithAdis,
    stats: PollStats,
    semaphore: Semaphore
  ): Promise<void> {
    await semaphore.acquire();
    try {
      await this.processUser(user, stats);
    } finally {
      semaphore.release();
    }
  }

  /**
   * Process a single user
   */
  private async processUser(
    user: CertenUserWithAdis,
    stats: PollStats
  ): Promise<void> {
    try {
      // Skip users without ADIs
      if (!user.adis || user.adis.length === 0) {
        stats.skippedUsers++;
        logUserContext('debug', 'Skipping user without ADIs', user.uid);
        return;
      }

      // Discover signing paths for all user's ADIs
      const allPaths: SigningPath[] = [];
      const pathsByAdi: Record<string, string[]> = {};
      for (const adi of user.adis) {
        const result = await this.signingPathService.discoverSigningPaths(adi);
        allPaths.push(...result.paths);
        pathsByAdi[adi.adiUrl] = result.paths.map(p => p.path);

        // Sync ADI key books if changes detected on network
        if (this.keyBooksChanged(adi.keyBooks, result.discoveredKeyBooks)) {
          logger.info(`[${user.uid.substring(0, 8)}] Key books changed for ${adi.adiUrl}`, {
            firestoreBooks: (adi.keyBooks || []).length,
            discoveredBooks: result.discoveredKeyBooks.length,
          });
          await this.firestore.updateAdiKeyBooks(user.uid, adi.adiUrl, result.discoveredKeyBooks);
          stats.firestoreWrites++;
        }
      }

      logger.info(`[${user.uid.substring(0, 8)}] Signing paths discovered`, {
        adiCount: user.adis.length,
        totalPaths: allPaths.length,
        byAdi: pathsByAdi,
      });

      // Update user doc with all discovered signing paths (legacy + structured)
      const allPathStrings = allPaths.map(p => p.path);
      await this.firestore.updateUserSigningPaths(user.uid, allPathStrings, pathsByAdi);

      // Write structured signing paths with per-hop metadata
      const structuredPaths: FirestoreSigningPath[] = allPaths.map(p => ({
        path: p.path,
        hops: (p.structuredHops || []).map(h => ({
          url: h.url,
          keyBookUrl: h.keyBookUrl,
          adiUrl: h.adiUrl,
          threshold: h.threshold,
          totalEntries: h.totalEntries,
          isDelegateHop: h.isDelegateHop,
        })),
        finalSigner: p.finalSigner,
        directPath: p.directPath,
        depth: p.depth,
        discoveredAt: this.firestore.createTimestamp(p.discoveredAt),
        validatedAt: this.firestore.now(),
      }));
      await this.firestore.updateUserSigningPathsStructured(user.uid, structuredPaths);

      // Discover pending transactions
      const discovery = await this.discoveryService.discoverPendingForUser(
        user,
        allPaths
      );

      stats.totalPending += discovery.totalCount;

      if (discovery.totalCount > 0 || discovery.awaitingOthersCount > 0) {
        logger.info(`[${user.uid.substring(0, 8)}] Pending transactions discovered`, {
          eligible: discovery.totalCount,
          awaitingOthers: discovery.awaitingOthersCount,
          transactions: discovery.eligibleTransactions.map(et => ({
            hash: et.tx.hash.substring(0, 16) + '...',
            type: et.tx.type,
            principal: et.tx.principal,
            category: et.category,
            signatures: et.tx.signatures.length,
          })),
          awaitingOthersTxs: discovery.awaitingOthersTransactions.map(et => ({
            hash: et.tx.hash.substring(0, 16) + '...',
            type: et.tx.type,
            principal: et.tx.principal,
            signatures: et.tx.signatures.length,
          })),
        });
      } else {
        logger.info(`[${user.uid.substring(0, 8)}] No pending transactions found`);
      }

      logDiscoveryResult(user.uid, discovery.totalCount, allPaths.length);

      // Update Firestore
      const result = await this.stateManager.updateUserPendingState(
        user.uid,
        discovery,
        null
      );

      stats.firestoreWrites++;
      stats.processedUsers++;
      if (discovery.degraded) {
        stats.degradedUsers++;
      }

      if (discovery.totalCount > 0) {
        logUserContext('info', `Found ${discovery.totalCount} pending actions`, user.uid, {
          signingPaths: allPaths.length,
          added: result.added,
          removed: result.removed,
        });
      }

    } catch (error) {
      stats.failedUsers++;
      logUserContext('error', 'Failed to process user', user.uid, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Gracefully shutdown the poller
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down poller...');
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait (bounded) for any in-flight cycle to finish so SIGTERM during a
    // routine deploy can't kill a Firestore reconcile mid-commit and leave a
    // user's pending list half-written.
    const deadlineMs = Date.now() + 25_000;
    while (this.isTicking && Date.now() < deadlineMs) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (this.isTicking) {
      logger.warn('Shutdown proceeding while a poll cycle is still in-flight (wait timed out)');
    }

    logger.info('Poller shutdown complete');
  }

  /**
   * Setup handlers for shutdown signals
   */
  private setupShutdownHandlers(): void {
    const handleShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, initiating shutdown`);
      await this.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  }

  /**
   * Compare Firestore key books with network-discovered key books.
   * Returns true if any difference is detected.
   */
  private keyBooksChanged(
    firestoreBooks: CertenKeyBook[] | undefined,
    discoveredBooks: CertenKeyBook[]
  ): boolean {
    const fsBooks = firestoreBooks || [];
    if (fsBooks.length !== discoveredBooks.length) return true;

    const fsMap = new Map(fsBooks.map(b => [b.url, b]));

    for (const db of discoveredBooks) {
      const fb = fsMap.get(db.url);
      if (!fb) return true;

      const fsPages = fb.keyPages || [];
      const dbPages = db.keyPages || [];
      if (fsPages.length !== dbPages.length) return true;

      const fpMap = new Map(fsPages.map(p => [p.url, p]));
      for (const dp of dbPages) {
        const fp = fpMap.get(dp.url);
        if (!fp) return true;
        if (fp.version !== dp.version) return true;
        if (fp.threshold !== dp.threshold) return true;
        if ((fp.entries?.length || 0) !== (dp.entries?.length || 0)) return true;
      }
    }

    return false;
  }

  /**
   * Check if the poller is currently running
   */
  get running(): boolean {
    return this.isRunning;
  }
}

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
import { CertenUserWithAdis, SigningPath, PollStats, createPollStats } from '../types';
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
  private pollTimer: NodeJS.Timeout | null = null;

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

    // Initial poll
    await this.tick();

    // Schedule periodic polls
    this.pollTimer = setInterval(
      () => this.tick(),
      this.config.pollIntervalSec * 1000
    );

    // Handle shutdown signals
    this.setupShutdownHandlers();
  }

  /**
   * Execute a single poll cycle
   */
  async tick(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const startTime = Date.now();
    const stats = createPollStats();

    logPollStart();

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

    } catch (error) {
      logger.error('Poll cycle failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
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
        const paths = await this.signingPathService.discoverSigningPaths(adi);
        allPaths.push(...paths);
        pathsByAdi[adi.adiUrl] = paths.map(p => p.path);
      }

      logger.info(`[${user.uid.substring(0, 8)}] Signing paths discovered`, {
        adiCount: user.adis.length,
        totalPaths: allPaths.length,
        byAdi: pathsByAdi,
      });

      // Update user doc with all discovered signing paths
      const allPathStrings = allPaths.map(p => p.path);
      await this.firestore.updateUserSigningPaths(user.uid, allPathStrings);

      // Discover pending transactions
      const discovery = await this.discoveryService.discoverPendingForUser(
        user,
        allPaths
      );

      stats.totalPending += discovery.totalCount;

      if (discovery.totalCount > 0) {
        logger.info(`[${user.uid.substring(0, 8)}] Pending transactions discovered`, {
          count: discovery.totalCount,
          transactions: discovery.eligibleTransactions.map(et => ({
            hash: et.tx.hash.substring(0, 16) + '...',
            type: et.tx.type,
            principal: et.tx.principal,
            category: et.category,
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
   * Check if the poller is currently running
   */
  get running(): boolean {
    return this.isRunning;
  }
}

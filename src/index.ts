/**
 * Certen Pending Transaction Discovery Service
 *
 * Entry point for the service that discovers pending multi-signature
 * transactions for Certen users by scanning the Accumulate network.
 */

import { config } from './config';
import { PendingActionsPoller } from './poller/poller';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  logger.info('=================================================');
  logger.info('Certen Pending Transaction Discovery Service');
  logger.info('=================================================');
  logger.info('Configuration:', {
    firebaseProject: config.firebaseProjectId,
    accumulateUrl: config.accumulateApiUrl,
    network: config.accumulateNetwork,
    pollInterval: `${config.pollIntervalSec}s`,
    concurrency: config.userConcurrency,
    dryRun: config.dryRun,
    logLevel: config.logLevel,
  });

  // Create and start the poller
  const poller = new PendingActionsPoller(config);

  try {
    await poller.start();

    // Keep the process running
    logger.info('Service started successfully. Press Ctrl+C to stop.');

    // Wait indefinitely (shutdown handlers will handle exit)
    await new Promise(() => {});

  } catch (error) {
    logger.error('Failed to start service', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Run main
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

/**
 * Configuration Module
 *
 * Loads and validates environment configuration for the pending discovery service.
 */

import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface AppConfig {
  // Firebase
  firebaseProjectId: string;
  firestoreEmulatorHost?: string;
  googleCredentialsPath?: string;

  // Accumulate
  accumulateApiUrl: string;
  accumulateNetwork: 'mainnet' | 'testnet' | 'devnet';

  // Polling
  pollIntervalSec: number;
  userConcurrency: number;
  maxRetries: number;

  // Health server
  healthPort: number;

  // Discovery
  delegationDepth: number;
  pendingPageSize: number;

  // Firestore Collections
  usersCollection: string;
  pendingActionsSubcollection: string;
  computedStateSubcollection: string;

  // Debug
  dryRun: boolean;
  enableDebugDump: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Parse an integer env var, rejecting NaN / out-of-range values at startup.
 * A bad POLL_INTERVAL_SEC or USER_CONCURRENCY would otherwise silently hot-loop
 * (setInterval(NaN)) or hang forever (Semaphore(0)), which is invisible without
 * the health endpoint — fail fast instead.
 */
function parseIntEnv(name: string, def: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got: "${raw}"`);
  }
  return n;
}

function validateConfig(): AppConfig {
  const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
  if (!firebaseProjectId) {
    throw new Error('FIREBASE_PROJECT_ID environment variable is required');
  }

  const accumulateNetwork = process.env.ACCUMULATE_NETWORK || 'mainnet';
  if (!['mainnet', 'testnet', 'devnet'].includes(accumulateNetwork)) {
    throw new Error('ACCUMULATE_NETWORK must be one of: mainnet, testnet, devnet');
  }

  const logLevel = process.env.LOG_LEVEL || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be one of: debug, info, warn, error');
  }

  return {
    firebaseProjectId,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    googleCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,

    accumulateApiUrl: process.env.ACCUMULATE_API_URL || 'https://mainnet.accumulatenetwork.io/v3',
    accumulateNetwork: accumulateNetwork as 'mainnet' | 'testnet' | 'devnet',

    pollIntervalSec: parseIntEnv('POLL_INTERVAL_SEC', 600, 1),
    userConcurrency: parseIntEnv('USER_CONCURRENCY', 8, 1),
    maxRetries: parseIntEnv('MAX_RETRIES', 3, 0),

    healthPort: parseIntEnv('HEALTH_PORT', 8080, 1),

    delegationDepth: parseIntEnv('DELEGATION_DEPTH', 20, 1),
    pendingPageSize: parseIntEnv('PENDING_PAGE_SIZE', 100, 1),

    usersCollection: process.env.USERS_COLLECTION || 'users',
    pendingActionsSubcollection: 'pendingActions',
    computedStateSubcollection: 'computedState',

    dryRun: process.env.DRY_RUN === 'true',
    enableDebugDump: process.env.ENABLE_DEBUG_DUMP === 'true',
    logLevel: logLevel as 'debug' | 'info' | 'warn' | 'error',
  };
}

// Export singleton config
export const config = validateConfig();

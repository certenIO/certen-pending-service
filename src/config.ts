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

    pollIntervalSec: parseInt(process.env.POLL_INTERVAL_SEC || '600', 10),
    userConcurrency: parseInt(process.env.USER_CONCURRENCY || '8', 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),

    delegationDepth: parseInt(process.env.DELEGATION_DEPTH || '10', 10),
    pendingPageSize: parseInt(process.env.PENDING_PAGE_SIZE || '100', 10),

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

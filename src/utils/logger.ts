/**
 * Logger Utility
 *
 * Structured logging using Winston for the pending discovery service.
 */

import winston from 'winston';
import { config } from '../config';

const { combine, timestamp, printf, colorize, json } = winston.format;

// Custom format for console output
const consoleFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let metaStr = '';
  if (Object.keys(metadata).length > 0) {
    metaStr = ' ' + JSON.stringify(metadata);
  }
  return `${timestamp} [${level}]: ${message}${metaStr}`;
});

// Create logger instance
export const logger = winston.createLogger({
  level: config.logLevel,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    json()
  ),
  defaultMeta: { service: 'certen-pending-service' },
  transports: [
    // Console transport with colors for development
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'HH:mm:ss.SSS' }),
        consoleFormat
      ),
    }),
  ],
});

// In production, you might add file transport or cloud logging
if (process.env.NODE_ENV === 'production') {
  // Could add file transport or cloud logging here
  // logger.add(new winston.transports.File({ filename: 'error.log', level: 'error' }));
}

/**
 * Log with user context
 */
export function logUserContext(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  uid: string,
  metadata?: Record<string, unknown>
): void {
  logger.log(level, message, {
    uid: uid.substring(0, 8) + '...',
    ...metadata,
  });
}

/**
 * Log poll cycle start
 */
export function logPollStart(): void {
  logger.info('Poll cycle starting');
}

/**
 * Log poll cycle completion
 */
export function logPollComplete(stats: {
  totalUsers: number;
  processedUsers: number;
  skippedUsers: number;
  failedUsers: number;
  totalPending: number;
  duration: number;
}): void {
  logger.info('Poll cycle completed', stats);
}

/**
 * Log discovery result for a user
 */
export function logDiscoveryResult(
  uid: string,
  count: number,
  signingPaths: number
): void {
  logger.debug('Discovery completed', {
    uid: uid.substring(0, 8) + '...',
    pendingCount: count,
    signingPaths,
  });
}

/**
 * Log Accumulate RPC call
 */
export function logRpcCall(
  method: string,
  scope: string,
  duration: number
): void {
  logger.debug('RPC call', { method, scope, durationMs: duration });
}

/**
 * Log Firestore operation
 */
export function logFirestoreOp(
  operation: 'read' | 'write' | 'delete',
  collection: string,
  count: number
): void {
  logger.debug('Firestore operation', { operation, collection, count });
}

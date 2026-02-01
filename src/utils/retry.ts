/**
 * Retry Utility
 *
 * Provides retry with exponential backoff for network operations.
 */

import { logger } from './logger';

export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Optional function to determine if error is retryable */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Check if an error is a network/transient error that should be retried
 */
function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Network errors
    if (message.includes('network') || message.includes('timeout')) {
      return true;
    }
    // Rate limiting
    if (message.includes('rate limit') || message.includes('429')) {
      return true;
    }
    // Server errors (5xx)
    if (message.includes('500') || message.includes('502') ||
        message.includes('503') || message.includes('504')) {
      return true;
    }
    // Connection errors
    if (message.includes('econnrefused') || message.includes('econnreset') ||
        message.includes('etimedout')) {
      return true;
    }
  }
  return false;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  multiplier: number
): number {
  // Exponential backoff
  const exponentialDelay = initialDelay * Math.pow(multiplier, attempt);
  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  // Add jitter (10-30% random variation)
  const jitter = cappedDelay * (0.1 + Math.random() * 0.2);
  return Math.floor(cappedDelay + jitter);
}

/**
 * Execute a function with retry logic
 *
 * @param fn The async function to execute
 * @param context Description of the operation for logging
 * @param options Retry configuration options
 * @returns The result of the function
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  const isRetryable = opts.isRetryable || isTransientError;

  let lastError: unknown;
  let attempt = 0;

  while (attempt <= opts.maxRetries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt >= opts.maxRetries || !isRetryable(error)) {
        logger.error(`${context} failed after ${attempt + 1} attempts`, {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
          maxRetries: opts.maxRetries,
        });
        throw error;
      }

      // Calculate delay and wait
      const delay = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier
      );

      logger.warn(`${context} failed, retrying in ${delay}ms`, {
        error: error instanceof Error ? error.message : String(error),
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: delay,
      });

      await sleep(delay);
      attempt++;
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

/**
 * A simpler retry function for operations that should be retried a fixed number of times
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  return withRetry(fn, 'Operation', {
    maxRetries,
    initialDelayMs: delayMs,
    maxDelayMs: delayMs * 4,
    backoffMultiplier: 1.5,
  });
}

/**
 * Semaphore for controlling concurrency
 */
export class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>(resolve => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.waiting.length > 0 && this.permits > 0) {
      this.permits--;
      const next = this.waiting.shift();
      next?.();
    }
  }

  /**
   * Get current available permits
   */
  getAvailable(): number {
    return this.permits;
  }

  /**
   * Get number of waiters
   */
  getWaiting(): number {
    return this.waiting.length;
  }
}

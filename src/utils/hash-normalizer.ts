/**
 * Hash Normalizer Utility
 *
 * Normalizes transaction hashes to a consistent format for comparison and storage.
 */

/**
 * Normalize a transaction hash to lowercase without 0x prefix
 * This ensures consistent comparison and storage of hashes.
 */
export function normalizeHash(hash: string): string {
  if (!hash) {
    return '';
  }

  // Remove 0x prefix if present
  let normalized = hash.toLowerCase();
  if (normalized.startsWith('0x')) {
    normalized = normalized.substring(2);
  }

  return normalized;
}

/**
 * Normalize a transaction hash for display (with 0x prefix)
 */
export function formatHashForDisplay(hash: string): string {
  const normalized = normalizeHash(hash);
  return normalized ? `0x${normalized}` : '';
}

/**
 * Check if two hashes are equal (case-insensitive, prefix-agnostic)
 */
export function hashesEqual(hash1: string, hash2: string): boolean {
  return normalizeHash(hash1) === normalizeHash(hash2);
}

/**
 * Truncate a hash for logging (first 8 + last 6 chars)
 */
export function truncateHash(hash: string): string {
  const normalized = normalizeHash(hash);
  if (normalized.length <= 16) {
    return normalized;
  }
  return `${normalized.substring(0, 8)}...${normalized.substring(normalized.length - 6)}`;
}

/**
 * Validate that a string is a valid hex hash
 */
export function isValidHash(hash: string): boolean {
  const normalized = normalizeHash(hash);
  return /^[0-9a-f]{32,128}$/i.test(normalized);
}

/**
 * Normalize a public key hash for comparison
 */
export function normalizePublicKeyHash(hash: string): string {
  return normalizeHash(hash);
}

/**
 * Check if a public key hash matches any in a set
 */
export function publicKeyHashInSet(
  hash: string,
  hashSet: Set<string>
): boolean {
  return hashSet.has(normalizePublicKeyHash(hash));
}

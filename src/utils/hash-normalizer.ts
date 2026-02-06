/**
 * Hash Normalizer Utility
 *
 * Normalizes transaction hashes to a consistent format for comparison and storage.
 */

/**
 * Normalize a transaction hash to a canonical lowercase hex string.
 * Strips: 0x prefix, acc:// prefix, @principal suffix, path segments.
 * Aligned with Dart service's normalizeHash().
 */
export function normalizeHash(hash: string): string {
  if (!hash) {
    return '';
  }

  let normalized = hash.trim().toLowerCase();

  // Remove 0x prefix
  if (normalized.startsWith('0x')) {
    normalized = normalized.substring(2);
  }

  // Remove acc:// prefix (txId format: acc://HASH@principal)
  if (normalized.startsWith('acc://')) {
    normalized = normalized.substring(6);
  }

  // Remove @principal suffix
  const atIndex = normalized.indexOf('@');
  if (atIndex > 0) {
    normalized = normalized.substring(0, atIndex);
  }

  // Remove path segments
  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    normalized = normalized.substring(0, slashIndex);
  }

  return normalized.trim();
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

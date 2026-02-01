/**
 * URL Normalizer Utility
 *
 * Normalizes Accumulate URLs to a consistent format for comparison and storage.
 */

/**
 * Normalize an Accumulate URL to lowercase without trailing slash
 */
export function normalizeUrl(url: string): string {
  if (!url) {
    return '';
  }

  // Ensure lowercase
  let normalized = url.toLowerCase().trim();

  // Ensure acc:// prefix
  if (!normalized.startsWith('acc://')) {
    // Handle case where only // is missing
    if (normalized.startsWith('acc:')) {
      normalized = 'acc://' + normalized.substring(4);
    } else {
      normalized = 'acc://' + normalized;
    }
  }

  // Remove trailing slash
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Check if two Accumulate URLs are equal
 */
export function urlsEqual(url1: string, url2: string): boolean {
  return normalizeUrl(url1) === normalizeUrl(url2);
}

/**
 * Extract the ADI portion from an Accumulate URL
 * e.g., "acc://myadi.acme/book/1" -> "acc://myadi.acme"
 */
export function extractAdiFromUrl(url: string): string {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return '';
  }

  // Remove acc:// prefix for processing
  const path = normalized.substring(6); // Remove 'acc://'

  // Find the first path separator
  const slashIndex = path.indexOf('/');
  if (slashIndex === -1) {
    return normalized; // No path, return as-is
  }

  return 'acc://' + path.substring(0, slashIndex);
}

/**
 * Get the path portion after the ADI
 * e.g., "acc://myadi.acme/book/1" -> "/book/1"
 */
export function getPathFromUrl(url: string): string {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return '';
  }

  const path = normalized.substring(6); // Remove 'acc://'
  const slashIndex = path.indexOf('/');
  if (slashIndex === -1) {
    return '';
  }

  return path.substring(slashIndex);
}

/**
 * Check if a URL is a key page URL
 * Key pages typically end with /book/{number} or similar
 */
export function isKeyPageUrl(url: string): boolean {
  const normalized = normalizeUrl(url);
  // Check if it matches pattern like acc://adi.acme/book/1
  return /\/book(s)?\/\d+$/i.test(normalized) || /\/page\/\d+$/i.test(normalized);
}

/**
 * Check if a URL is a key book URL
 */
export function isKeyBookUrl(url: string): boolean {
  const normalized = normalizeUrl(url);
  return /\/book(s)?$/i.test(normalized);
}

/**
 * Get the parent key book URL from a key page URL
 * e.g., "acc://myadi.acme/book/1" -> "acc://myadi.acme/book"
 */
export function getKeyBookFromKeyPage(keyPageUrl: string): string {
  const normalized = normalizeUrl(keyPageUrl);
  // Remove the last path segment (the page number)
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash > 6) { // Ensure we don't remove the acc:// part
    return normalized.substring(0, lastSlash);
  }
  return normalized;
}

/**
 * Build a key page URL from a key book URL and page number
 */
export function buildKeyPageUrl(keyBookUrl: string, pageNumber: number): string {
  return `${normalizeUrl(keyBookUrl)}/${pageNumber}`;
}

/**
 * Check if URL starts with a specific ADI
 */
export function urlStartsWithAdi(url: string, adiUrl: string): boolean {
  const normalizedUrl = normalizeUrl(url);
  const normalizedAdi = normalizeUrl(adiUrl);
  return normalizedUrl.startsWith(normalizedAdi);
}

/**
 * Encode a URL for use as a Firestore document ID
 * Firestore doc IDs can't contain /
 */
export function encodeUrlForDocId(url: string): string {
  return encodeURIComponent(normalizeUrl(url));
}

/**
 * Decode a Firestore document ID back to a URL
 */
export function decodeDocIdToUrl(docId: string): string {
  return decodeURIComponent(docId);
}

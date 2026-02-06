/**
 * Accumulate JSON-RPC Client
 *
 * Client for interacting with the Accumulate network via JSON-RPC.
 */

import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../config';
import {
  AccumulatePendingTx,
  AccumulateSignature,
  JsonRpcResponse,
  AccumulateKeyPage,
  AccumulateKeyEntry,
} from '../types';
import { withRetry } from '../utils/retry';
import { logger, logRpcCall } from '../utils/logger';
import { normalizeUrl } from '../utils/url-normalizer';
import { normalizeHash } from '../utils/hash-normalizer';

export class AccumulateClient {
  private readonly rpcUrl: string;
  private readonly httpClient: AxiosInstance;
  private readonly maxRetries: number;
  private requestId = 0;

  constructor(config: AppConfig) {
    this.rpcUrl = config.accumulateApiUrl;
    this.maxRetries = config.maxRetries;
    this.httpClient = axios.create({
      baseURL: this.rpcUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Query pending transaction IDs for an account (v3 format).
   * Returns raw txID strings (e.g. "acc://HASH@principal").
   */
  async queryPendingTxIds(
    scope: string,
    options: { pageSize?: number; maxPages?: number } = {}
  ): Promise<string[]> {
    const { pageSize = 200, maxPages = 20 } = options;
    const txIds: string[] = [];
    let start = 0;

    for (let page = 0; page < maxPages; page++) {
      let response: Record<string, unknown>;
      try {
        response = await this.call<Record<string, unknown>>('query', {
          scope: normalizeUrl(scope),
          query: {
            queryType: 'pending',
            range: { start, count: pageSize },
          },
        });
      } catch {
        break;
      }

      // Extract records from v3 response (multiple formats)
      let records: unknown[];
      const pending = response.pending as Record<string, unknown> | undefined;
      if (pending && Array.isArray(pending.records)) {
        // v3 primary: response.pending.records
        records = pending.records;
      } else if (response.recordType === 'range' && Array.isArray(response.records)) {
        // v3 alt: response.records (range format)
        records = response.records;
      } else if (Array.isArray(response.items)) {
        // Legacy fallback: response.items
        records = response.items;
      } else {
        break;
      }

      // Extract txIDs from records (tolerant parsing like Dart)
      const pageTxIds = this.extractTxIdsFromRecords(records);
      txIds.push(...pageTxIds);

      // Pagination: stop if we got fewer than requested
      if (records.length < pageSize) break;
      const total = response.total;
      if (typeof total === 'number' && start + records.length >= total) break;

      start += records.length;
    }

    // Deduplicate while preserving order
    const seen = new Set<string>();
    return txIds.filter(id => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  /**
   * Query pending transactions for an account (full details).
   * Fetches txIDs then queries each for full transaction data.
   */
  async queryPending(
    scope: string,
    options: { count?: number } = {}
  ): Promise<AccumulatePendingTx[]> {
    const { count = 200 } = options;

    const txIds = await this.queryPendingTxIds(scope, { pageSize: count });

    if (txIds.length === 0) {
      return [];
    }

    const pendingTxs: AccumulatePendingTx[] = [];
    for (const txId of txIds) {
      try {
        const txDetails = await this.queryTransaction(txId);
        if (txDetails) {
          pendingTxs.push(txDetails);
        }
      } catch (error) {
        logger.warn('Failed to fetch pending transaction details', {
          txId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return pendingTxs;
  }

  /**
   * Query a key book to get its page count
   */
  async queryKeyBookPageCount(keyBookUrl: string): Promise<number> {
    try {
      const response = await this.call<Record<string, unknown>>('query', {
        scope: normalizeUrl(keyBookUrl),
      });

      const account = response.account as Record<string, unknown> | undefined;
      const data = response.data as Record<string, unknown> | undefined;

      // v3: response.account.pageCount
      if (account?.type === 'keyBook' && typeof account.pageCount === 'number') {
        return account.pageCount;
      }

      // Alt: response.data.pageCount
      if (data?.type === 'keyBook' && typeof data.pageCount === 'number') {
        return data.pageCount;
      }

      // Fallback: top-level
      if (typeof response.pageCount === 'number') {
        return response.pageCount as number;
      }

      return 0;
    } catch (error) {
      logger.warn('Failed to query key book page count', {
        keyBookUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Query a key page to get its entries
   */
  async queryKeyPage(keyPageUrl: string): Promise<AccumulateKeyPage | null> {
    try {
      const response = await this.call<Record<string, unknown>>('query', {
        scope: normalizeUrl(keyPageUrl),
      });

      if (!response || response.type !== 'keyPage') {
        return null;
      }

      // Parse key page response
      const keys: AccumulateKeyEntry[] = [];
      const rawKeys = (response.keys as unknown[]) || [];

      for (const key of rawKeys) {
        const keyObj = key as Record<string, unknown>;
        if (keyObj.delegate) {
          keys.push({
            publicKeyHash: '',
            delegate: String(keyObj.delegate),
          });
        } else if (keyObj.publicKeyHash) {
          keys.push({
            publicKeyHash: normalizeHash(String(keyObj.publicKeyHash)),
            keyType: keyObj.keyType ? String(keyObj.keyType) : undefined,
            lastUsedOn: keyObj.lastUsedOn ? Number(keyObj.lastUsedOn) : undefined,
          });
        }
      }

      return {
        type: 'keyPage',
        url: normalizeUrl(keyPageUrl),
        version: Number(response.version) || 1,
        threshold: Number(response.acceptThreshold) || Number(response.threshold) || 1,
        creditBalance: Number(response.creditBalance) || 0,
        keys,
      };
    } catch (error) {
      logger.debug('Failed to query key page', {
        keyPageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Query signature chain for a key book/page.
   * Returns raw v3 response with records and total count.
   */
  async querySignatureChain(
    url: string,
    options: { start?: number; count?: number; expand?: boolean } = {}
  ): Promise<{ records: unknown[]; total: number }> {
    const { start = 0, count = 100, expand = false } = options;

    try {
      const response = await this.call<Record<string, unknown>>('query', {
        scope: normalizeUrl(url),
        query: {
          queryType: 'chain',
          name: 'signature',
          range: { start, count, expand },
        },
      });

      const records = (response.records as unknown[]) || [];
      const total = typeof response.total === 'number' ? response.total : records.length;

      return { records, total };
    } catch (error) {
      logger.debug('Failed to query signature chain', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return { records: [], total: 0 };
    }
  }

  /**
   * Query directory for sub-accounts
   */
  async queryDirectory(
    adiUrl: string,
    options: { start?: number; count?: number } = {}
  ): Promise<string[]> {
    const { start = 0, count = 100 } = options;

    try {
      const response = await this.call<Record<string, unknown>>('query', {
        scope: normalizeUrl(adiUrl),
        query: {
          queryType: 'directory',
          range: { start, count },
        },
      });

      const records = (response.records || response.entries || response.items) as unknown[] | undefined;
      if (!records) return [];

      return records
        .map((record) => {
          if (typeof record === 'string') return normalizeUrl(record);
          const rec = record as Record<string, unknown>;
          // v3 records: try value, account.url, url
          const url = rec.value || rec.url || (rec.account as Record<string, unknown>)?.url;
          if (typeof url === 'string') return normalizeUrl(url);
          logger.warn('Could not extract URL from directory record', {
            adiUrl,
            record: JSON.stringify(rec),
          });
          return null;
        })
        .filter((url): url is string => url !== null);
    } catch (error) {
      logger.warn('Failed to query directory', {
        adiUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get transaction details by hash or txid
   */
  async queryTransaction(txHashOrId: string): Promise<AccumulatePendingTx | null> {
    try {
      const response = await this.call<Record<string, unknown>>('query', {
        txid: txHashOrId,
      });

      return this.parseTransactionResponse(response, txHashOrId);
    } catch (error) {
      logger.debug('Failed to query transaction', {
        txHashOrId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Query a transaction and return raw v3 response (for status checking).
   */
  async queryTransactionRaw(txHashOrId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.call<Record<string, unknown>>('query', {
        txid: txHashOrId,
      });
    } catch {
      return null;
    }
  }

  /**
   * Check if an account exists
   */
  async accountExists(url: string): Promise<boolean> {
    try {
      await this.call<Record<string, unknown>>('query', {
        scope: normalizeUrl(url),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract txID strings from v3 records (tolerant parsing).
   * Handles: string value, map with txID/txId/id, nested message.txID, direct acc:// string.
   */
  private extractTxIdsFromRecords(records: unknown[]): string[] {
    const out: string[] = [];
    for (const rec of records) {
      if (typeof rec === 'object' && rec !== null) {
        const r = rec as Record<string, unknown>;
        const v = r.value;
        // Direct string value (most common v3 format)
        if (typeof v === 'string' && v.length > 0) {
          out.push(v);
          continue;
        }
        // Map value with txID/txId/id
        if (typeof v === 'object' && v !== null) {
          const vm = v as Record<string, unknown>;
          const txId = vm.txID || vm.txId || vm.id;
          if (typeof txId === 'string' && txId.length > 0) {
            out.push(txId);
            continue;
          }
          // Nested in message
          if (typeof vm.message === 'object' && vm.message !== null) {
            const msg = vm.message as Record<string, unknown>;
            const msgTxId = msg.txID;
            if (typeof msgTxId === 'string' && msgTxId.length > 0) {
              out.push(msgTxId);
              continue;
            }
          }
        }
        // Legacy: txid or hash fields
        const txid = r.txid || r.hash;
        if (typeof txid === 'string' && txid.length > 0) {
          out.push(txid);
          continue;
        }
      } else if (typeof rec === 'string' && rec.startsWith('acc://')) {
        out.push(rec);
      }
    }
    return out;
  }

  /**
   * Make a JSON-RPC call with retry logic
   */
  private async call<T>(method: string, params: unknown): Promise<T> {
    const startTime = Date.now();
    const id = ++this.requestId;

    const result = await withRetry(
      async () => {
        const response = await this.httpClient.post<JsonRpcResponse<T>>('', {
          jsonrpc: '2.0',
          id,
          method,
          params,
        });

        if (response.data.error) {
          throw new Error(response.data.error.message || 'Unknown RPC error');
        }

        return response.data.result as T;
      },
      `RPC ${method}`,
      { maxRetries: this.maxRetries }
    );

    const duration = Date.now() - startTime;
    const scope = typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>).scope as string || 'N/A'
      : 'N/A';
    logRpcCall(method, scope, duration);

    return result;
  }

  /**
   * Parse v3 transaction query response into AccumulatePendingTx.
   * Handles multiple v3 response structures for signatures and status.
   */
  private parseTransactionResponse(
    response: Record<string, unknown>,
    txIdHint?: string
  ): AccumulatePendingTx | null {
    if (!response) return null;

    // v3: transaction data may be in response.message.transaction or response.transaction
    const message = this.asMap(response.message);
    const transaction = this.asMap(message.transaction || response.transaction);
    if (!transaction.header && !transaction.body) {
      // No transaction data found at all
      if (!response.status && !response.type) return null;
    }

    const header = this.asMap(transaction.header);
    const body = this.asMap(transaction.body);

    // Extract signatures from all three v3 structures
    const signatures = this.extractSignaturesV3(response);

    // Determine status (v3 supports string, map, and code formats)
    const statusStr = this.parseStatusV3(response);

    // Extract txId and hash
    const txId = String(response.id || response.txid || txIdHint || '');
    const hash = normalizeHash(txId || String(response.hash || ''));

    return {
      txId,
      hash,
      principal: normalizeUrl(String(header.principal || '')),
      type: String(body.type || message.type || ''),
      status: statusStr,
      signatures,
      expiresAt: header.expire ? new Date(Number(header.expire) * 1000) : undefined,
      data: body as unknown as AccumulatePendingTx['data'],
    };
  }

  /**
   * Extract signatures from v3 transaction response.
   * Handles three structures:
   *   1. signatures.records[].signatures.records[].message.signature (nested)
   *   2. signatureBooks.pages[].signatures (paginated)
   *   3. signatures as flat array (legacy)
   */
  private extractSignaturesV3(txResult: Record<string, unknown>): AccumulateSignature[] {
    const out: AccumulateSignature[] = [];
    const sigField = txResult.signatures;

    // STRUCTURE 1: signatures.records[].signatures.records[].message.signature
    if (typeof sigField === 'object' && sigField !== null && !Array.isArray(sigField)) {
      const sigRange = sigField as Record<string, unknown>;
      const sets = sigRange.records;
      if (Array.isArray(sets)) {
        for (const set of sets) {
          const setMap = this.asMap(set);
          const inner = this.asMap(setMap.signatures);
          const recs = inner.records;
          if (!Array.isArray(recs)) continue;

          for (const rec of recs) {
            const recMap = this.asMap(rec);
            const msg = this.asMap(recMap.message);
            if (String(msg.type || '') !== 'signature') continue;

            const sig = this.asMap(msg.signature);
            const signerUrl = this.deepFindSigner(sig);
            if (!signerUrl) continue;

            out.push({
              signer: normalizeUrl(signerUrl),
              publicKeyHash: normalizeHash(String(sig.publicKeyHash || '')),
              signature: String(sig.signature || ''),
              timestamp: this.parseMicrosTimestamp(sig.timestamp),
              vote: this.parseVote(sig.vote),
            });
          }
        }
      }
    }

    // STRUCTURE 2: signatureBooks.pages[].signatures
    const books = txResult.signatureBooks;
    if (Array.isArray(books)) {
      for (const book of books) {
        const pages = this.asMap(book).pages;
        if (!Array.isArray(pages)) continue;
        for (const page of pages) {
          const pageSigs = this.asMap(page).signatures;
          const recs = Array.isArray(pageSigs)
            ? pageSigs
            : (typeof pageSigs === 'object' && pageSigs !== null
                ? (pageSigs as Record<string, unknown>).records
                : null);
          if (!Array.isArray(recs)) continue;

          for (const rec of recs) {
            const recMap = this.asMap(rec);
            const msg = this.asMap(recMap.message);
            if (String(msg.type || '') !== 'signature') continue;

            const sig = this.asMap(msg.signature);
            const signerUrl = this.deepFindSigner(sig);
            if (!signerUrl) continue;

            out.push({
              signer: normalizeUrl(signerUrl),
              publicKeyHash: normalizeHash(String(sig.publicKeyHash || '')),
              signature: String(sig.signature || ''),
              timestamp: this.parseMicrosTimestamp(sig.timestamp),
              vote: this.parseVote(sig.vote),
            });
          }
        }
      }
    }

    // STRUCTURE 3: signatures as flat array (legacy/simple)
    if (Array.isArray(sigField)) {
      for (const sigSet of sigField) {
        const setMap = this.asMap(sigSet);
        const signerUrl = setMap.signer;
        const setSignerUrl = typeof signerUrl === 'object' && signerUrl !== null
          ? String((signerUrl as Record<string, unknown>).url || '')
          : String(signerUrl || '');

        const innerSigs = setMap.signatures;
        if (Array.isArray(innerSigs)) {
          for (const sig of innerSigs) {
            const s = this.asMap(sig);
            if (s.publicKeyHash) {
              out.push({
                signer: normalizeUrl(setSignerUrl || String(s.signer || '')),
                publicKeyHash: normalizeHash(String(s.publicKeyHash)),
                signature: String(s.signature || ''),
                timestamp: s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(),
                vote: this.parseVote(s.vote || setMap.vote),
                transactionHash: s.transactionHash ? String(s.transactionHash) : undefined,
              });
            }
          }
        } else if (setSignerUrl) {
          // Single signature entry in flat array
          out.push({
            signer: normalizeUrl(setSignerUrl),
            publicKeyHash: normalizeHash(String(setMap.publicKeyHash || '')),
            signature: String(setMap.signature || ''),
            timestamp: setMap.timestamp ? new Date(Number(setMap.timestamp) * 1000) : new Date(),
            vote: this.parseVote(setMap.vote),
          });
        }
      }
    }

    // Deduplicate by signer+timestamp
    const seen = new Set<string>();
    return out.filter(s => {
      const key = `${s.signer}|${s.publicKeyHash}|${s.timestamp?.getTime() || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Recursively find signer URL in nested delegated signature structures.
   */
  private deepFindSigner(sig: Record<string, unknown>): string | null {
    const s = sig.signer;
    if (typeof s === 'string' && s.length > 0) return s;
    const inner = this.asMap(sig.signature);
    if (Object.keys(inner).length === 0) return null;
    return this.deepFindSigner(inner);
  }

  /**
   * Parse v3 status field (string, map, or code).
   */
  private parseStatusV3(response: Record<string, unknown>): string {
    const statusField = response.status;

    // String format: "pending", "delivered"
    if (typeof statusField === 'string') {
      return statusField.toLowerCase();
    }

    // Map format: { code: "pending"|202, pending: true }
    if (typeof statusField === 'object' && statusField !== null) {
      const statusMap = statusField as Record<string, unknown>;
      const code = statusMap.code;

      // Numeric code: 202=pending, 201=delivered
      if (typeof code === 'number') {
        if (code === 202) return 'pending';
        if (code === 201) return 'delivered';
        return 'unknown';
      }

      // String code
      if (typeof code === 'string') {
        const c = code.toLowerCase();
        if (c === 'pending') return 'pending';
        if (c === 'delivered' || c === 'ok') return 'delivered';
        return c;
      }

      // Boolean flag fallback
      if (statusMap.pending === true) return 'pending';
      if (statusMap.delivered === true) return 'delivered';
    }

    return 'unknown';
  }

  /**
   * Parse microsecond timestamp from v3 API.
   */
  private parseMicrosTimestamp(ts: unknown): Date {
    if (!ts) return new Date();
    const n = Number(ts);
    // v3 uses microseconds (> 1e15), v2 uses seconds (< 1e12)
    if (n > 1e15) return new Date(n / 1000);
    if (n > 1e12) return new Date(n);
    return new Date(n * 1000);
  }

  /**
   * Safely cast unknown to Record<string, unknown>.
   */
  private asMap(v: unknown): Record<string, unknown> {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return {};
  }

  /**
   * Parse vote string to typed vote
   */
  private parseVote(vote: unknown): 'approve' | 'reject' | 'abstain' | undefined {
    if (!vote) return undefined;
    const v = String(vote).toLowerCase();
    if (v === 'accept' || v === 'approve') return 'approve';
    if (v === 'reject') return 'reject';
    if (v === 'abstain') return 'abstain';
    return undefined;
  }
}

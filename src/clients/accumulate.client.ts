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
  SignatureChainEntry,
  TransactionQueryResponse,
  PendingQueryResponse,
  ChainQueryResponse,
  DirectoryQueryResponse,
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
   * Query pending transactions for an account
   */
  async queryPending(
    scope: string,
    options: { start?: number; count?: number } = {}
  ): Promise<AccumulatePendingTx[]> {
    const { start = 0, count = 100 } = options;

    const response = await this.call<PendingQueryResponse>('query', {
      scope: normalizeUrl(scope),
      query: {
        queryType: 'pending',
        range: { start, count },
      },
    });

    if (!response.items || response.items.length === 0) {
      return [];
    }

    // Fetch full transaction details for each pending item
    const pendingTxs: AccumulatePendingTx[] = [];
    for (const item of response.items) {
      try {
        const txDetails = await this.queryTransaction(item.txid || item.hash);
        if (txDetails) {
          pendingTxs.push(txDetails);
        }
      } catch (error) {
        logger.warn('Failed to fetch pending transaction details', {
          txid: item.txid,
          hash: item.hash,
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

      const data = response.data as Record<string, unknown> | undefined;
      if (data?.type === 'keyBook' && typeof data.pageCount === 'number') {
        return data.pageCount;
      }

      // Fallback: check top-level
      if (response.type === 'keyBook' && typeof response.pageCount === 'number') {
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
   * Query signature chain for a key page (to discover delegations)
   */
  async querySignatureChain(
    keyPageUrl: string,
    options: { start?: number; count?: number } = {}
  ): Promise<SignatureChainEntry[]> {
    const { start = 0, count = 100 } = options;

    try {
      const response = await this.call<ChainQueryResponse & { records?: unknown[] }>('query', {
        scope: normalizeUrl(keyPageUrl),
        query: {
          queryType: 'chain',
          name: 'signature',
          range: { start, count, expand: true },
        },
      });

      if (!response.records) {
        return [];
      }

      return response.records.map((record: unknown) => this.parseSignatureChainEntry(record));
    } catch (error) {
      logger.debug('Failed to query signature chain', {
        keyPageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
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

      // v3 API returns { records: [ { value: "acc://...", ... }, ... ] }
      const records = (response.records || response.entries || response.items) as unknown[] | undefined;

      if (records && records.length > 0) {
        logger.info('Directory query record sample', {
          adiUrl,
          total: response.total,
          firstRecord: JSON.stringify(records[0]),
        });
      }

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
      const response = await this.call<TransactionQueryResponse>('query', {
        txid: txHashOrId,
      });

      return this.parseTransactionResponse(response);
    } catch (error) {
      logger.debug('Failed to query transaction', {
        txHashOrId,
        error: error instanceof Error ? error.message : String(error),
      });
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
   * Parse transaction query response into AccumulatePendingTx
   */
  private parseTransactionResponse(response: TransactionQueryResponse): AccumulatePendingTx | null {
    if (!response || !response.transaction) {
      return null;
    }

    const { transaction, status, signatures: sigSets } = response;
    const header = transaction.header;
    const body = transaction.body;

    // Parse signatures from signature sets
    const signatures: AccumulateSignature[] = [];
    for (const sigSet of sigSets || []) {
      for (const sig of sigSet.signatures || []) {
        if (sig.publicKeyHash) {
          signatures.push({
            signer: normalizeUrl(sigSet.signer?.url || sig.signer || ''),
            publicKeyHash: normalizeHash(sig.publicKeyHash),
            signature: sig.signature || '',
            timestamp: sig.timestamp ? new Date(sig.timestamp * 1000) : new Date(),
            vote: this.parseVote(sig.vote || sigSet.vote),
            transactionHash: sig.transactionHash,
          });
        }
      }
    }

    // Determine status
    const statusStr = status?.pending ? 'pending' : status?.delivered ? 'delivered' : 'unknown';

    return {
      txId: '', // Will be populated from the query
      hash: '', // Will be populated from the query
      principal: normalizeUrl(header.principal),
      type: body.type,
      status: statusStr,
      signatures,
      expiresAt: header.expire ? new Date(header.expire * 1000) : undefined,
      data: body,
    };
  }

  /**
   * Parse a signature chain entry
   */
  private parseSignatureChainEntry(record: unknown): SignatureChainEntry {
    const rec = record as Record<string, unknown>;
    const value = rec.value as Record<string, unknown> || rec;

    return {
      type: String(value.type || 'unknown'),
      txId: String(value.txid || ''),
      hash: String(value.hash || ''),
      principal: normalizeUrl(String(value.principal || '')),
      status: String(value.status || 'unknown'),
      body: value.body as SignatureChainEntry['body'],
      signatures: this.parseSignatures(value.signatures),
    };
  }

  /**
   * Parse signatures array
   */
  private parseSignatures(sigs: unknown): AccumulateSignature[] {
    if (!Array.isArray(sigs)) {
      return [];
    }

    return sigs.map((sig: unknown) => {
      const s = sig as Record<string, unknown>;
      return {
        signer: normalizeUrl(String(s.signer || '')),
        publicKeyHash: normalizeHash(String(s.publicKeyHash || '')),
        signature: String(s.signature || ''),
        timestamp: s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(),
        vote: this.parseVote(s.vote),
      };
    });
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

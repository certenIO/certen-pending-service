/**
 * Health / heartbeat HTTP server.
 *
 * A headless poller has no inbound API, so without this an operator (or Docker
 * HEALTHCHECK) cannot tell "running fine" from "wedged but alive". This exposes:
 *   GET /healthz  -> 200 when the last poll cycle is fresh, 503 when stale/stuck
 *   GET /metrics  -> JSON snapshot (last cycle stats, heartbeat age)
 */

import http from 'http';
import { logger } from '../utils/logger';

export interface HealthProvider {
  getHealthSnapshot(): {
    healthy: boolean;
    isRunning: boolean;
    isTicking: boolean;
    lastSuccessfulTickAt: number | null;
    secondsSinceLastSuccess: number | null;
    tickRunningMs: number;
    stale: boolean;
    stuck: boolean;
    lastError: string | null;
    lastStats: unknown;
  };
}

export function startHealthServer(provider: HealthProvider, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/healthz' || url === '/health') {
      const snap = provider.getHealthSnapshot();
      res.writeHead(snap.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snap));
      return;
    }
    if (url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(provider.getHealthSnapshot()));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.on('error', (err) => {
    logger.error('Health server error', { error: err.message });
  });

  server.listen(port, () => {
    logger.info('Health server listening', { port });
  });

  return server;
}

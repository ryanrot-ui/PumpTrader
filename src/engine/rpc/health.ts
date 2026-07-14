/**
 * Per-endpoint RPC health accounting: latency EMA, timeout/failure counters,
 * a 0–100 health score, and a failover history ring buffer. The engine feeds
 * it every probe/poll outcome; the dashboard renders snapshot().
 *
 * Health score: starts at 100; each failure subtracts, each success restores,
 * and slow latency drags it down. Failover picks the healthiest endpoint
 * other than the current one, so a flapping endpoint isn't chosen again
 * while a better one exists.
 */

export interface EndpointHealth {
  url: string;
  health: number; // 0..100
  latencyMs: number | null; // EMA
  successes: number;
  failures: number;
  timeouts: number;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

// type alias (not interface) so it satisfies Prisma's InputJsonValue when the
// snapshot is written into EngineState.health
export type FailoverEvent = {
  at: number;
  from: string;
  to: string;
  reason: string;
};

const LATENCY_ALPHA = 0.3; // EMA smoothing
const FAIL_PENALTY = 25;
const TIMEOUT_PENALTY = 30;
const SUCCESS_RECOVERY = 10;
const MAX_FAILOVER_HISTORY = 20;

export function isTimeoutError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /timeout|timed out|ETIMEDOUT|aborted|AbortError/i.test(msg);
}

export class RpcHealthTracker {
  private endpoints = new Map<string, EndpointHealth>();
  readonly failoverHistory: FailoverEvent[] = [];

  constructor(urls: string[]) {
    for (const url of urls) {
      this.endpoints.set(url, {
        url,
        health: 100,
        latencyMs: null,
        successes: 0,
        failures: 0,
        timeouts: 0,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
      });
    }
  }

  private get(url: string): EndpointHealth {
    let h = this.endpoints.get(url);
    if (!h) {
      h = {
        url,
        health: 100,
        latencyMs: null,
        successes: 0,
        failures: 0,
        timeouts: 0,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
      };
      this.endpoints.set(url, h);
    }
    return h;
  }

  recordSuccess(url: string, latencyMs: number): void {
    const h = this.get(url);
    h.successes++;
    h.consecutiveFailures = 0;
    h.lastSuccessAt = Date.now();
    h.latencyMs =
      h.latencyMs === null ? latencyMs : h.latencyMs * (1 - LATENCY_ALPHA) + latencyMs * LATENCY_ALPHA;
    // Slow endpoints are unhealthy endpoints, even when they answer.
    const latencyDrag = h.latencyMs > 2_000 ? 10 : h.latencyMs > 800 ? 4 : 0;
    h.health = Math.min(100, h.health + SUCCESS_RECOVERY) - latencyDrag;
    h.health = Math.max(0, Math.min(100, h.health));
  }

  recordFailure(url: string, err: unknown): void {
    const h = this.get(url);
    const timeout = isTimeoutError(err);
    h.failures++;
    if (timeout) h.timeouts++;
    h.consecutiveFailures++;
    h.lastErrorAt = Date.now();
    h.lastError = err instanceof Error ? err.message : String(err);
    h.health = Math.max(0, h.health - (timeout ? TIMEOUT_PENALTY : FAIL_PENALTY));
  }

  consecutiveFailures(url: string): number {
    return this.get(url).consecutiveFailures;
  }

  /** Healthiest endpoint other than `current` (undefined when none exist). */
  bestAlternative(current: string): string | undefined {
    const others = [...this.endpoints.values()].filter((h) => h.url !== current);
    if (others.length === 0) return undefined;
    return others.sort((a, b) => b.health - a.health)[0].url;
  }

  recordFailover(from: string, to: string, reason: string): void {
    this.failoverHistory.push({ at: Date.now(), from, to, reason });
    if (this.failoverHistory.length > MAX_FAILOVER_HISTORY) this.failoverHistory.shift();
  }

  snapshot(currentUrl: string) {
    const eps = [...this.endpoints.values()];
    const current = this.endpoints.get(currentUrl) ?? null;
    return {
      rpcEndpoints: eps.map((h) => ({
        url: h.url,
        active: h.url === currentUrl,
        health: Math.round(h.health),
        latencyMs: h.latencyMs === null ? null : Math.round(h.latencyMs),
        timeouts: h.timeouts,
        failures: h.failures,
        lastSuccessAt: h.lastSuccessAt,
        lastError: h.lastError,
      })),
      rpcHealth: current ? Math.round(current.health) : null,
      rpcTimeouts: current?.timeouts ?? 0,
      rpcLastSuccessAt: current?.lastSuccessAt ?? null,
      rpcFailoverHistory: this.failoverHistory.slice(-10),
    };
  }
}

/**
 * Retry helper for transient RPC failures (timeouts, 429s, connection
 * resets): exponential backoff, never retries on obviously permanent errors.
 * A single timeout must never surface as a failed scan cycle.
 */
export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries?: number;
    baseDelayMs?: number;
    onRetry?: (err: unknown, attempt: number) => void;
  } = {}
): Promise<T> {
  const { retries = 2, baseDelayMs = 500, onRetry } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = isTimeoutError(e) || /429|rate.?limit|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|503|502/i.test(msg);
      if (!transient || attempt === retries) throw e;
      onRetry?.(e, attempt + 1);
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

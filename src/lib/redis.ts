import Redis from "ioredis";

/**
 * Redis is OPTIONAL. The database is the source of truth for all state
 * (settings, engine status, heartbeat, health). When REDIS_URL is set, Redis
 * adds two fast paths: pub/sub for instant settings/control propagation and
 * the dashboard live feed. When it is not set — or the server goes away —
 * everything still works via DB polling; nothing here may throw or spam logs.
 *
 * Log hygiene: ioredis emits an error for every failed reconnect attempt.
 * We log a single line on the up→down transition and one on recovery.
 */

const REDIS_URL = process.env.REDIS_URL?.trim();

export const redisEnabled = Boolean(REDIS_URL);

function createClient(): Redis | null {
  if (!REDIS_URL) return null;
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 2_000, 30_000),
  });
  attachQuietLogging(client, "redis");
  return client;
}

function attachQuietLogging(client: Redis, label: string): void {
  let down = false;
  client.on("error", (err: Error) => {
    if (!down) {
      down = true;
      console.warn(
        `[${label}] unavailable (${err.message}) — continuing without it; will keep retrying quietly`
      );
    }
  });
  client.on("ready", () => {
    if (down) {
      down = false;
      console.info(`[${label}] connection restored`);
    }
  });
}

const globalForRedis = globalThis as unknown as { redis?: Redis | null; redisLogged?: boolean };

/** Shared client, or null when REDIS_URL is not configured. */
export const redis: Redis | null =
  globalForRedis.redis !== undefined ? globalForRedis.redis : createClient();

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

// One-time status line so "is Redis actually on?" is answerable from the logs.
// Redis is an optional accelerator — the app is fully functional without it
// (engine heartbeat, status, settings and the feed all live in PostgreSQL).
if (!globalForRedis.redisLogged) {
  globalForRedis.redisLogged = true;
  if (REDIS_URL) {
    const scheme = REDIS_URL.startsWith("rediss://") ? "rediss (TLS)" : "redis";
    console.info(`[redis] enabled via REDIS_URL (${scheme}) — pub/sub fast path active when reachable`);
  } else {
    console.info("[redis] not configured — running on PostgreSQL only (this is fully supported)");
  }
}

/** Fire-and-forget publish; silently a no-op without Redis. */
export function publish(channel: string, message: string): void {
  void redis?.publish(channel, message).catch(() => {});
}

/**
 * Subscribe on a dedicated connection. Returns an unsubscribe function.
 * Without Redis this is a no-op — callers must have a DB-polling fallback.
 */
export function subscribe(channel: string, handler: (message: string) => void): () => void {
  if (!redis) return () => {};
  const sub = redis.duplicate();
  attachQuietLogging(sub, `redis:sub:${channel}`);
  void sub.subscribe(channel).catch(() => {});
  sub.on("message", (ch, msg) => {
    if (ch === channel) handler(msg);
  });
  return () => {
    void sub.unsubscribe().catch(() => {});
    sub.disconnect();
  };
}

// ── Pub/sub channels shared by the web app and the engine ──────────────────
export const CHANNELS = {
  settingsUpdated: "bot:settings-updated", // settings changed → engine reloads
  control: "bot:control", // emergency_stop | resume (fast path; DB is fallback)
  liveFeed: "bot:feed", // JSON log events for the dashboard live feed
} as const;

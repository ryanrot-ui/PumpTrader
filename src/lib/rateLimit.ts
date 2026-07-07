import { redis } from "./redis";

/**
 * Fixed-window counters used for rate limiting and login brute-force
 * protection. Backed by Redis when available (shared across instances);
 * otherwise an in-memory fallback — correct for the single-instance
 * deployments this app targets, and strictly better than failing open.
 */

const memory = new Map<string, { count: number; expiresAt: number }>();
const MEMORY_MAX_KEYS = 10_000;

function memoryIncrement(key: string, windowSeconds: number): number {
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (memory.size >= MEMORY_MAX_KEYS) {
      // Drop expired entries; if everything is live, reset (fail-open beats OOM)
      for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
      if (memory.size >= MEMORY_MAX_KEYS) memory.clear();
    }
    memory.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/** Increment a windowed counter and return the new count. Never throws. */
export async function incrementWindow(key: string, windowSeconds: number): Promise<number> {
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds);
      return count;
    } catch {
      /* fall through to memory */
    }
  }
  return memoryIncrement(key, windowSeconds);
}

/** Read a windowed counter without incrementing. Never throws. */
export async function readWindow(key: string): Promise<number> {
  if (redis) {
    try {
      const v = await redis.get(key);
      return v ? parseInt(v, 10) : 0;
    } catch {
      /* fall through to memory */
    }
  }
  const entry = memory.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.count : 0;
}

/** Clear a counter (e.g. after a successful login). Never throws. */
export async function clearWindow(key: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(key);
      return;
    } catch {
      /* fall through to memory */
    }
  }
  memory.delete(key);
}

/**
 * Fixed-window rate limiter. Returns true when the request is allowed.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const bucket = `rl:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  return (await incrementWindow(bucket, windowSeconds)) <= limit;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

import { redis } from "./redis";

/**
 * Fixed-window rate limiter backed by Redis.
 * Returns true when the request is allowed.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const bucket = `rl:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  try {
    const count = await redis.incr(bucket);
    if (count === 1) await redis.expire(bucket, windowSeconds);
    return count <= limit;
  } catch {
    // Redis down: fail open for reads but callers guarding mutations should
    // treat errors upstream. Keeping the app usable beats hard-failing.
    return true;
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

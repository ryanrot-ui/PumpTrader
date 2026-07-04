import Redis from "ioredis";

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

// ── Well-known keys / channels shared by the web app and the engine ────────
export const KEYS = {
  botStatus: "bot:status", // running | stopped | emergency_stopped
  botHeartbeat: "bot:heartbeat", // unix ms of last engine loop
  settingsChannel: "bot:settings-updated", // pub/sub: settings changed, reload
  controlChannel: "bot:control", // pub/sub: start | stop | emergency_stop
  liveFeed: "bot:feed", // pub/sub: JSON events for the dashboard live log
} as const;

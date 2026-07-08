import { z } from "zod";

/**
 * Environment validation — fail fast and loudly at process start instead of
 * mysteriously at 3am mid-trade. `validateEnv("engine")` and
 * `validateEnv("web")` check the variables each process actually needs.
 */

const common = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgresql://")),
  // Optional: pub/sub fast path + shared rate-limit counters. Everything
  // falls back to database polling / in-memory counters without it.
  REDIS_URL: z.string().min(1).optional(),
});

const engineExtra = z.object({
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_WS_URL: z.string().optional(),
  // comma-separated failover RPC endpoints (optional)
  SOLANA_RPC_URLS: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),
});

const webExtra = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16, "NEXTAUTH_SECRET must be a strong random value"),
});

/**
 * Platform-provided defaults. Netlify injects the site's public URL as URL
 * (production) / DEPLOY_PRIME_URL (deploy previews); NextAuth needs it as
 * NEXTAUTH_URL. An explicitly configured NEXTAUTH_URL always wins (custom
 * domains). Call before anything reads NEXTAUTH_URL.
 */
export function applyPlatformEnvDefaults(): void {
  if (!process.env.NEXTAUTH_URL) {
    const url = process.env.URL ?? process.env.DEPLOY_PRIME_URL;
    if (url) process.env.NEXTAUTH_URL = url;
  }
}

export function validateEnv(kind: "engine" | "web"): void {
  applyPlatformEnvDefaults();
  const schema = kind === "engine" ? common.merge(engineExtra) : common.merge(webExtra);
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment for ${kind}:\n${problems}`);
  }

  // WALLET_ENCRYPTION_KEY is only mandatory once live trading is used, but a
  // malformed value should still be rejected at boot.
  const key = process.env.WALLET_ENCRYPTION_KEY;
  if (key && !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("WALLET_ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)");
  }
}

/** Every RPC endpoint available for failover, primary first, de-duplicated. */
export function rpcEndpoints(): string[] {
  const primary = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const extra = (process.env.SOLANA_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([primary, ...extra])];
}

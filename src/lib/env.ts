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
  // Optional: falls back to the public mainnet endpoint via rpcEndpoints().
  // A dedicated RPC is strongly recommended for real use (the public one is
  // heavily rate-limited), but the engine must boot without any RPC config.
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_WS_URL: z.string().optional(),
  // comma-separated failover RPC endpoints (optional)
  SOLANA_RPC_URLS: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),
});

const webExtra = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16, "NEXTAUTH_SECRET must be a strong random value"),
});

export function validateEnv(kind: "engine" | "web"): void {
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

  if (kind === "engine" && !process.env.SOLANA_RPC_URL) {
    console.warn(
      "[env] SOLANA_RPC_URL not set — using the public mainnet endpoint " +
        "(rate-limited). Set a dedicated RPC (Helius/QuickNode/Triton) for real use."
    );
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

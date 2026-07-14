import { z } from "zod";

/** JSON-configurable scoring weights (overrides built-in defaults). */
export const scoringWeightsSchema = z.object({
  liquidity: z.number().min(0).max(100),
  marketCap: z.number().min(0).max(100),
  volume: z.number().min(0).max(100),
  volumeGrowth: z.number().min(0).max(100),
  buyPressure: z.number().min(0).max(100),
  holders: z.number().min(0).max(100),
  holderGrowth: z.number().min(0).max(100),
  distribution: z.number().min(0).max(100),
  walletQuality: z.number().min(0).max(100),
  momentum: z.number().min(0).max(100),
  stability: z.number().min(0).max(100),
  safety: z.number().min(0).max(100),
  activity: z.number().min(0).max(100),
});

/** JSON-configurable narrative-score component weights. */
export const narrativeWeightsSchema = z.object({
  socialPresence: z.number().min(0).max(100),
  attentionVelocity: z.number().min(0).max(100),
  mentionVelocity: z.number().min(0).max(100),
  engagement: z.number().min(0).max(100),
  communityGrowth: z.number().min(0).max(100),
  crossPlatform: z.number().min(0).max(100),
  sentiment: z.number().min(0).max(100),
});

/** Zod schema for every live-editable bot setting. Mirrors prisma Settings. */
export const settingsSchema = z.object({
  // Buying
  buyAmountSol: z.number().positive().max(100),
  confidenceThreshold: z.number().int().min(0).max(100),
  minLiquiditySol: z.number().min(0),
  maxLiquiditySol: z.number().positive().nullable(),
  minMarketCapUsd: z.number().min(0),
  maxMarketCapUsd: z.number().positive(),
  minHolders: z.number().int().min(0),
  minVolume5mUsd: z.number().min(0),
  minBuyPressure: z.number().min(0).max(50),
  maxWhalePct: z.number().positive().max(100),
  maxDevPct: z.number().positive().max(100),
  maxSlippageBps: z.number().int().min(1).max(5000),

  // Selling
  takeProfitPct: z.number().positive().max(100000),
  stopLossPct: z.number().positive().max(100),
  trailingStopPct: z.number().positive().max(100).nullable(),
  maxHoldMinutes: z.number().int().positive().nullable(),
  sellPortionPct: z.number().positive().max(100),

  // Momentum exits (scalping) — null = disabled
  exitMinBuySellRatio: z.number().min(0).max(10).nullable(),
  exitVolumeFadePct: z.number().min(1).max(100).nullable(),
  exitLiquidityDropPct: z.number().min(1).max(100),

  // Entry timing (anti-chase) — null = gate disabled
  maxEntryPriceChange5mPct: z.number().min(1).max(10_000).nullable(),
  maxEntryPriceChange1hPct: z.number().min(1).max(100_000).nullable(),
  requireRisingMomentum: z.boolean(),
  minConfirmations: z.number().int().min(0).max(6),
  adaptiveThreshold: z.boolean(),

  // Adaptive exits
  letWinnersRun: z.boolean(),
  adaptiveTrailing: z.boolean(),
  cutWeakAfterMinutes: z.number().min(0.5).max(24 * 60).nullable(),
  breakevenAfterPct: z.number().positive().max(1000).nullable(),

  // Learning analytics
  autoRebalanceWeights: z.boolean(),
  reportEveryTrades: z.number().int().min(20).max(100_000),

  // Risk
  maxSolPerTrade: z.number().positive().max(1000),
  maxOpenPositions: z.number().int().min(1).max(50),
  maxDailyLossSol: z.number().positive(),
  dailyProfitTarget: z.number().positive().nullable(),
  maxExposureSol: z.number().positive(),
  lossCooldownMin: z.number().int().min(0).max(24 * 60),

  // Execution
  priorityFeeLamports: z.number().int().min(0).max(10_000_000).nullable(),
  retryCount: z.number().int().min(0).max(10),
  scannerIntervalSec: z.number().int().min(5).max(300),
  scoringWeights: scoringWeightsSchema.nullable(),

  // Narrative intelligence (null = gate disabled)
  minNarrativeScore: z.number().int().min(0).max(100).nullable(),
  minMemeScore: z.number().int().min(0).max(100).nullable(),
  maxRugRiskScore: z.number().int().min(0).max(100).nullable(),
  narrativeExitMode: z.enum(["off", "alert", "execute"]),
  narrativeWeights: narrativeWeightsSchema.nullable(),

  // Engine
  botEnabled: z.boolean(),
  paperTrading: z.boolean(),
});

/**
 * Settings-form updates. botEnabled and paperTrading are deliberately
 * excluded: they are controlled through /api/bot (start/stop and the
 * confirmed paper↔live mode switch), so a stale settings form can never
 * silently flip the trading mode.
 */
export const settingsUpdateSchema = settingsSchema.omit({
  botEnabled: true,
  paperTrading: true,
});

export type BotSettings = z.infer<typeof settingsSchema>;
export type ScoringWeightsInput = z.infer<typeof scoringWeightsSchema>;

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(128),
});

export const importWalletSchema = z.object({
  // base58-encoded 64-byte secret key (Phantom export format)
  secretKey: z.string().min(64).max(128),
  label: z.string().max(50).optional(),
});

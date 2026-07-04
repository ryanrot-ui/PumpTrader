import { z } from "zod";

/** Zod schema for every live-editable bot setting. Mirrors prisma Settings. */
export const settingsSchema = z.object({
  // Buying
  buyAmountSol: z.number().positive().max(100),
  confidenceThreshold: z.number().int().min(0).max(100),
  minLiquiditySol: z.number().min(0),
  minMarketCapUsd: z.number().min(0),
  maxMarketCapUsd: z.number().positive(),
  minHolders: z.number().int().min(0),
  minVolume5mUsd: z.number().min(0),
  maxSlippageBps: z.number().int().min(1).max(5000),

  // Selling
  takeProfitPct: z.number().positive().max(100000),
  stopLossPct: z.number().positive().max(100),
  trailingStopPct: z.number().positive().max(100).nullable(),
  maxHoldMinutes: z.number().int().positive().nullable(),
  sellPortionPct: z.number().positive().max(100),

  // Risk
  maxSolPerTrade: z.number().positive().max(1000),
  maxOpenPositions: z.number().int().min(1).max(50),
  maxDailyLossSol: z.number().positive(),
  dailyProfitTarget: z.number().positive().nullable(),
  maxExposureSol: z.number().positive(),
  lossCooldownMin: z.number().int().min(0).max(24 * 60),

  // Engine
  botEnabled: z.boolean(),
  paperTrading: z.boolean(),
});

export type BotSettings = z.infer<typeof settingsSchema>;

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

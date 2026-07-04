import { prisma } from "@/lib/prisma";
import { redis, KEYS } from "@/lib/redis";
import { settingsSchema, type BotSettings } from "@/lib/validation";
import { logger } from "./logging/logger";

/**
 * Live settings loader. The engine holds settings in memory and reloads them
 * when the web app publishes on the settings channel — no restart needed.
 * The first user's settings row drives the engine (single-operator design;
 * extend to per-user engines by keying this on userId).
 */

export const DEFAULT_SETTINGS: BotSettings = settingsSchema.parse({
  buyAmountSol: 0.1,
  confidenceThreshold: 85,
  minLiquiditySol: 50,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 2_000_000,
  minHolders: 100,
  minVolume5mUsd: 5_000,
  maxSlippageBps: 300,
  takeProfitPct: 100,
  stopLossPct: 30,
  trailingStopPct: null,
  maxHoldMinutes: null,
  sellPortionPct: 100,
  maxSolPerTrade: 0.25,
  maxOpenPositions: 3,
  maxDailyLossSol: 1,
  dailyProfitTarget: null,
  maxExposureSol: 1,
  lossCooldownMin: 15,
  botEnabled: false,
  paperTrading: true,
});

export class LiveConfig {
  private current: BotSettings = DEFAULT_SETTINGS;
  private sub = redis.duplicate();

  get(): BotSettings {
    return this.current;
  }

  async start(): Promise<void> {
    await this.reload();
    await this.sub.subscribe(KEYS.settingsChannel);
    this.sub.on("message", (channel) => {
      if (channel === KEYS.settingsChannel) {
        this.reload().catch((e) =>
          logger.error("engine", `settings reload failed: ${(e as Error).message}`)
        );
      }
    });
  }

  async stop(): Promise<void> {
    await this.sub.unsubscribe().catch(() => {});
    this.sub.disconnect();
  }

  async reload(): Promise<void> {
    const row = await prisma.settings.findFirst({ orderBy: { updatedAt: "desc" } });
    if (!row) {
      this.current = DEFAULT_SETTINGS;
      return;
    }
    const parsed = settingsSchema.safeParse({
      buyAmountSol: row.buyAmountSol,
      confidenceThreshold: row.confidenceThreshold,
      minLiquiditySol: row.minLiquiditySol,
      minMarketCapUsd: row.minMarketCapUsd,
      maxMarketCapUsd: row.maxMarketCapUsd,
      minHolders: row.minHolders,
      minVolume5mUsd: row.minVolume5mUsd,
      maxSlippageBps: row.maxSlippageBps,
      takeProfitPct: row.takeProfitPct,
      stopLossPct: row.stopLossPct,
      trailingStopPct: row.trailingStopPct,
      maxHoldMinutes: row.maxHoldMinutes,
      sellPortionPct: row.sellPortionPct,
      maxSolPerTrade: row.maxSolPerTrade,
      maxOpenPositions: row.maxOpenPositions,
      maxDailyLossSol: row.maxDailyLossSol,
      dailyProfitTarget: row.dailyProfitTarget,
      maxExposureSol: row.maxExposureSol,
      lossCooldownMin: row.lossCooldownMin,
      botEnabled: row.botEnabled,
      paperTrading: row.paperTrading,
    });
    if (parsed.success) {
      this.current = parsed.data;
      logger.info("engine", "settings reloaded", { paperTrading: parsed.data.paperTrading });
    } else {
      logger.error("engine", `stored settings invalid, keeping previous: ${parsed.error.message}`);
    }
  }
}

import { prisma } from "@/lib/prisma";
import { subscribe, CHANNELS } from "@/lib/redis";
import { settingsSchema, type BotSettings } from "@/lib/validation";
import { logger } from "./logging/logger";

/**
 * Live settings loader. The engine holds settings in memory and reloads them
 * from the database — no restart needed. Changes are picked up two ways:
 * a periodic DB poll (always on, so Redis is never required) and a Redis
 * pub/sub notification when Redis is configured (instant propagation).
 * The first user's settings row drives the engine (single-operator design;
 * extend to per-user engines by keying this on userId).
 */

const POLL_INTERVAL_MS = 5_000;

export const DEFAULT_SETTINGS: BotSettings = settingsSchema.parse({
  buyAmountSol: 0.1,
  confidenceThreshold: 85,
  minLiquiditySol: 50,
  maxLiquiditySol: null,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 2_000_000,
  minHolders: 100,
  minVolume5mUsd: 5_000,
  minBuyPressure: 1.2,
  maxWhalePct: 15,
  maxDevPct: 10,
  maxSlippageBps: 300,
  // Scalping defaults: many small disciplined wins, not rare moonshots.
  takeProfitPct: 12,
  stopLossPct: 6,
  trailingStopPct: 5,
  maxHoldMinutes: 10,
  sellPortionPct: 100,
  exitMinBuySellRatio: 0.75,
  exitVolumeFadePct: 65,
  exitLiquidityDropPct: 25,
  maxSolPerTrade: 0.25,
  maxOpenPositions: 3,
  maxDailyLossSol: 1,
  dailyProfitTarget: null,
  maxExposureSol: 1,
  lossCooldownMin: 15,
  priorityFeeLamports: null,
  retryCount: 2,
  scannerIntervalSec: 15,
  scoringWeights: null,
  minNarrativeScore: null,
  minMemeScore: null,
  maxRugRiskScore: null,
  narrativeExitMode: "off",
  narrativeWeights: null,
  botEnabled: false,
  paperTrading: true,
});

export class LiveConfig {
  private current: BotSettings = DEFAULT_SETTINGS;
  private lastUpdatedAt: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  get(): BotSettings {
    return this.current;
  }

  /** updatedAt of the settings row currently loaded (diagnostics). */
  get loadedSettingsUpdatedAtMs(): number | null {
    return this.lastUpdatedAt;
  }

  async start(): Promise<void> {
    await this.reload();
    // Fast path: instant reload when Redis is configured (no-op otherwise).
    this.unsubscribe = subscribe(CHANNELS.settingsUpdated, () => void this.safeReload());
    // Always-on fallback: cheap updatedAt check every few seconds.
    this.pollTimer = setInterval(() => void this.pollForChanges(), POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async pollForChanges(): Promise<void> {
    try {
      const row = await prisma.settings.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      });
      const stamp = row?.updatedAt.getTime() ?? null;
      if (stamp !== this.lastUpdatedAt) await this.reload();
    } catch {
      /* DB hiccup — next poll retries; the engine keeps its current settings */
    }
  }

  private async safeReload(): Promise<void> {
    try {
      await this.reload();
    } catch (e) {
      logger.error("engine", `settings reload failed: ${(e as Error).message}`);
    }
  }

  async reload(): Promise<void> {
    const row = await prisma.settings.findFirst({ orderBy: { updatedAt: "desc" } });
    if (!row) {
      this.current = DEFAULT_SETTINGS;
      this.lastUpdatedAt = null;
      return;
    }
    this.lastUpdatedAt = row.updatedAt.getTime();
    const { id: _id, userId: _userId, updatedAt: _updatedAt, ...values } = row;
    const parsed = settingsSchema.safeParse(values);
    if (parsed.success) {
      const modeChanged = parsed.data.paperTrading !== this.current.paperTrading;
      this.current = parsed.data;
      logger.info("engine", `settings reloaded${modeChanged ? ` — trading mode is now ${parsed.data.paperTrading ? "PAPER" : "LIVE"}` : ""}`, {
        paperTrading: parsed.data.paperTrading,
        botEnabled: parsed.data.botEnabled,
      });
    } else {
      logger.error("engine", `stored settings invalid, keeping previous: ${parsed.error.message}`);
    }
  }
}

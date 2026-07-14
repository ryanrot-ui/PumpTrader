import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publish, CHANNELS } from "@/lib/redis";
import { logger } from "../logging/logger";
import { computeTradeStats, type BucketStat, type TradeStats } from "./tradeStats";
import { optimizeWeights, type WeightRecommendation } from "./optimizer";
import { assessFrequencyHealth, investigateBlockers } from "./frequency";
import { loadClosedTrades } from "./loadTrades";

/**
 * Strategy reports: every `reportEveryTrades` closed trades (and on demand)
 * the engine distills the full trade statistics, the weight-optimizer's
 * evidence, and concrete plain-language strategy adjustments into a
 * StrategyReport row. When autoRebalanceWeights is on, the recommended
 * scoring weights are applied to settings immediately (the engine hot-reloads
 * them like any settings change).
 */

export interface GeneratedReport {
  id: string;
  stats: TradeStats;
  recommendation: WeightRecommendation | null;
  adjustments: string[];
  weightsApplied: boolean;
}

const best = (buckets: BucketStat[], minTrades = 3) =>
  buckets.filter((b) => b.trades >= minTrades).sort((a, b) => b.pnlSol - a.pnlSol)[0] ?? null;
const worst = (buckets: BucketStat[], minTrades = 3) =>
  buckets.filter((b) => b.trades >= minTrades).sort((a, b) => a.pnlSol - b.pnlSol)[0] ?? null;

/** Plain-language strategy adjustments derived from the measured buckets. */
export function deriveAdjustments(stats: TradeStats): string[] {
  const out: string[] = [];
  if (stats.trades < 20) {
    out.push(`Only ${stats.trades} closed trades — treat every conclusion as provisional until ~100+.`);
    return out;
  }

  const bScore = best(stats.byScore);
  const wScore = worst(stats.byScore);
  if (bScore && wScore && bScore.label !== wScore.label) {
    out.push(
      `Score ${bScore.label} is the most profitable range (${bScore.pnlSol.toFixed(3)} SOL over ${bScore.trades} trades); ` +
        `${wScore.label} loses money (${wScore.pnlSol.toFixed(3)} SOL). Consider aligning confidenceThreshold with the profitable range.`
    );
  }
  const bAge = best(stats.byTokenAge);
  const wAge = worst(stats.byTokenAge);
  if (bAge && wAge && bAge.label !== wAge.label) {
    out.push(`Best token age at entry: ${bAge.label} after migration; worst: ${wAge.label}.`);
  }
  const bLiq = best(stats.byLiquidity);
  const wLiq = worst(stats.byLiquidity);
  if (bLiq && wLiq && bLiq.label !== wLiq.label) {
    out.push(`Best entry liquidity: ${bLiq.label} (${bLiq.pnlSol.toFixed(3)} SOL); worst: ${wLiq.label} — tune min/maxLiquiditySol toward the winning band.`);
  }
  const bExit = best(stats.byExitKind, 2);
  const wExit = worst(stats.byExitKind, 2);
  if (bExit && wExit && bExit.label !== wExit.label) {
    out.push(`Most profitable exit: ${bExit.label}; worst: ${wExit.label}.`);
  }
  if (wExit?.label === "time_exit" && wExit.pnlSol < 0) {
    out.push(`Time exits are losing money — positions that go nowhere are being held too long. Lower maxHoldMinutes or enable cutWeakAfterMinutes.`);
  }
  if (wExit?.label === "stop_loss" && stats.roundTrips > stats.trades * 0.1) {
    out.push(
      `${stats.roundTrips} trades peaked ≥ +5% unrealized but closed red — exits fire too late. Tighten trailingStopPct or enable adaptiveTrailing.`
    );
  }
  if ((stats.avgGivebackPct ?? 0) > 8) {
    out.push(
      `Winners give back ${stats.avgGivebackPct!.toFixed(1)}% on average between their peak and the exit — tighten the trailing stop.`
    );
  }
  if (
    stats.avgHoldMinutesLosers !== null &&
    stats.avgHoldMinutesWinners !== null &&
    stats.avgHoldMinutesLosers > stats.avgHoldMinutesWinners * 1.5
  ) {
    out.push(
      `Losers are held ${stats.avgHoldMinutesLosers.toFixed(1)} min vs ${stats.avgHoldMinutesWinners.toFixed(1)} min for winners — losing trades are not being cut fast enough.`
    );
  }
  if (stats.profitFactor !== null && stats.profitFactor < 1 && stats.winRate !== null) {
    if (stats.winRate >= 50) {
      out.push(
        `Win rate ${stats.winRate.toFixed(0)}% but profit factor ${stats.profitFactor.toFixed(2)} < 1: losses are too large relative to wins — tighten stopLossPct / cut weak trades earlier, or let winners run longer.`
      );
    } else {
      out.push(
        `Profit factor ${stats.profitFactor.toFixed(2)} with ${stats.winRate.toFixed(0)}% win rate: entries are the problem — raise confidenceThreshold and rely on the entry-timing gates (anti-chase) to skip exhausted moves.`
      );
    }
  }
  const hours = stats.byHourUtc.filter((b) => b.trades >= 3);
  if (hours.length >= 4) {
    const bh = hours.reduce((a, b) => (b.pnlSol > a.pnlSol ? b : a));
    const wh = hours.reduce((a, b) => (b.pnlSol < a.pnlSol ? b : a));
    if (bh.label !== wh.label)
      out.push(`Best trading hour (UTC): ${bh.label}; worst: ${wh.label}.`);
  }
  if (out.length === 0) out.push("No statistically significant weaknesses detected in this window.");
  return out;
}

export async function generateStrategyReport(opts: {
  mode?: "paper" | "live" | "all";
  trigger: "auto" | "manual";
  autoApplyWeights: boolean;
}): Promise<GeneratedReport> {
  const mode = opts.mode ?? "all";
  const trades = await loadClosedTrades({ mode });
  const stats = computeTradeStats(trades);
  const recommendation = optimizeWeights(trades);
  const adjustments = deriveAdjustments(stats);

  // Profit–frequency balance: win rate alone is never the objective. Flag
  // over-selectivity/over-trading with the measured numbers, and when
  // frequency dropped, name the gates responsible.
  const freq = assessFrequencyHealth(trades);
  if (freq.status === "over_selective" || freq.status === "over_trading") {
    const blockers = await investigateBlockers().catch(() => []);
    adjustments.unshift(
      `${freq.status.replace(/_/g, " ").toUpperCase()}: ${freq.detail}` +
        (blockers.length
          ? ` — top blocking gates (7d): ${blockers.slice(0, 3).map((b) => `${b.rule} (${b.count}×)`).join(", ")}`
          : "")
    );
  } else if (freq.status === "healthy") {
    adjustments.push(`Frequency healthy: ${freq.detail}`);
  }

  let weightsApplied = false;
  if (opts.autoApplyWeights && recommendation) {
    try {
      const settings = await prisma.settings.findFirst({ orderBy: { updatedAt: "desc" } });
      if (settings) {
        await prisma.settings.update({
          where: { id: settings.id },
          data: { scoringWeights: recommendation.recommended as unknown as Prisma.InputJsonValue },
        });
        // Revertible history for the automatic change too.
        await prisma.parameterChange
          .create({
            data: {
              source: "auto-rebalance",
              changedKeys: ["scoringWeights"],
              before: JSON.parse(JSON.stringify({ scoringWeights: settings.scoringWeights ?? null })),
              after: JSON.parse(JSON.stringify({ scoringWeights: recommendation.recommended })),
              note: recommendation.summary,
            },
          })
          .catch(() => {});
        publish(CHANNELS.settingsUpdated, "updated");
        weightsApplied = true;
        logger.info(
          "engine",
          `auto-rebalanced scoring weights from ${recommendation.tradesAnalyzed} trades: ${recommendation.summary}`
        );
      }
    } catch (e) {
      logger.warn("engine", `auto-rebalance failed (report still saved): ${(e as Error).message}`);
    }
  }

  const row = await prisma.strategyReport.create({
    data: {
      mode,
      trigger: opts.trigger,
      tradesAnalyzed: stats.trades,
      stats: JSON.parse(JSON.stringify({ ...stats, adjustments })),
      recommendations: recommendation ? JSON.parse(JSON.stringify(recommendation)) : Prisma.DbNull,
      weightsApplied,
    },
  });

  logger.info(
    "engine",
    `strategy report generated (${opts.trigger}): ${stats.trades} trades, ` +
      `win rate ${stats.winRate?.toFixed(1) ?? "–"}%, PF ${stats.profitFactor?.toFixed(2) ?? "–"}, ` +
      `expectancy ${stats.expectancySol?.toFixed(4) ?? "–"} SOL/trade` +
      (weightsApplied ? " — scoring weights auto-rebalanced" : ""),
    { reportId: row.id }
  );

  return { id: row.id, stats, recommendation, adjustments, weightsApplied };
}

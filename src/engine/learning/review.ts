import { prisma } from "@/lib/prisma";
import { logger } from "../logging/logger";
import { classifyExitKind } from "./tradeStats";

/**
 * Automatic post-trade review, generated after EVERY fully-closed position.
 *
 * Two outputs:
 *  - `causes`: ranked explanations of WHY the trade ended the way it did,
 *    each with a 0–100 confidence. Heuristics only claim what the recorded
 *    evidence supports — a cause with weak evidence gets low confidence.
 *  - `tags`: objective condition labels (late_entry, low_liquidity, …)
 *    assigned to winners and losers alike, so the lessons database can
 *    report a win rate per condition ("liquidity under 25 SOL: 19% WR").
 */

export interface TradeCause {
  cause: string;
  confidencePct: number;
  detail: string;
}

export interface ReviewInput {
  positionId: string;
  mint: string;
  symbol: string | null;
  paper: boolean;
  pnlSol: number;
  pnlPct: number | null;
  holdMinutes: number | null;
  exitReason: string;
  exitKind: string;
  maxUnrealizedPnlPct: number | null;
  maxDrawdownPct: number | null;
  takeProfitPct: number;
  stopLossPct: number;
  entrySignals: {
    scannerScore?: number;
    narrativeScore?: number;
    context?: {
      marketCapUsd?: number | null;
      liquiditySol?: number | null;
      volume5mUsd?: number | null;
      buySellRatio?: number | null;
      momentum?: number | null;
      momentumAcceleration?: number | null;
      priceChange5mPct?: number | null;
      priceChange1hPct?: number | null;
      volatility5m?: number | null;
      estSlippagePctFor1Sol?: number | null;
      holderCount?: number | null;
      tokenAgeMin?: number | null;
      detectionToBuyMs?: number | null;
    };
  } | null;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Objective condition tags — assigned regardless of outcome. */
export function deriveTags(r: ReviewInput): string[] {
  const c = r.entrySignals?.context ?? {};
  const tags: string[] = [];
  const add = (cond: boolean | null | undefined, tag: string) => {
    if (cond === true) tags.push(tag);
  };

  add(c.priceChange5mPct != null && c.priceChange5mPct > 20, "late_entry");
  add(c.priceChange5mPct != null && c.priceChange5mPct <= 10 && (c.momentumAcceleration ?? 0) > 0, "early_breakout");
  add(c.liquiditySol != null && c.liquiditySol < 25, "liquidity_under_25_sol");
  add(c.liquiditySol != null && c.liquiditySol >= 50, "liquidity_over_50_sol");
  add(c.momentumAcceleration != null && c.momentumAcceleration > 0.5, "momentum_accelerating");
  add(c.momentumAcceleration != null && c.momentumAcceleration < 0, "momentum_decelerating");
  add(c.buySellRatio != null && c.buySellRatio >= 2, "strong_buy_pressure");
  add(c.buySellRatio != null && c.buySellRatio < 1.2, "weak_buy_pressure");
  add(c.volatility5m != null && c.volatility5m > 12, "high_volatility");
  add(c.estSlippagePctFor1Sol != null && c.estSlippagePctFor1Sol > 1.5, "high_slippage");
  add(c.holderCount != null && c.holderCount < 100, "few_holders");
  add((r.entrySignals?.narrativeScore ?? null) != null && r.entrySignals!.narrativeScore! < 30, "weak_narrative");
  add(c.tokenAgeMin != null && c.tokenAgeMin < 3, "very_fresh_token");
  add(c.tokenAgeMin != null && c.tokenAgeMin > 20, "older_token");
  add(c.detectionToBuyMs != null && c.detectionToBuyMs > 120_000, "slow_pipeline_entry");
  add((r.entrySignals?.scannerScore ?? 0) >= 85, "score_85_plus");
  add((r.entrySignals?.scannerScore ?? 100) < 75, "score_under_75");
  return tags;
}

/** Ranked cause attribution with confidence. */
export function deriveCauses(r: ReviewInput): TradeCause[] {
  const c = r.entrySignals?.context ?? {};
  const causes: TradeCause[] = [];
  const add = (cause: string, confidencePct: number, detail: string) =>
    causes.push({ cause, confidencePct: clamp(confidencePct), detail });

  const win = r.pnlSol > 0;
  const peaked = r.maxUnrealizedPnlPct ?? 0;

  if (win) {
    // Winner attribution is simpler — what carried the trade.
    if (r.exitKind === "take_profit")
      add("target reached", 90, `hit the +${r.takeProfitPct}% target (peaked +${peaked.toFixed(1)}%)`);
    if (r.exitKind === "trailing_stop")
      add("rode momentum, trail locked gains", 85, `peaked +${peaked.toFixed(1)}%, exited +${r.pnlPct?.toFixed(1)}%`);
    if ((c.momentumAcceleration ?? 0) > 0)
      add("entered while momentum was building", 70, `acceleration ${c.momentumAcceleration?.toFixed(2)} at entry`);
    if ((c.buySellRatio ?? 0) >= 2)
      add("strong buy pressure at entry", 65, `buy/sell ${c.buySellRatio?.toFixed(2)}`);
    if (causes.length === 0) add("favourable exit", 50, `${r.exitKind} at +${r.pnlPct?.toFixed(1)}%`);
    return causes.sort((a, b) => b.confidencePct - a.confidencePct);
  }

  // ── Loss attribution ────────────────────────────────────────────────────
  // Exit-kind evidence (strongest signal about what actually happened)
  if (r.exitKind === "rug_exit") {
    const drained = /liquidity dropped/i.test(r.exitReason);
    add(
      drained ? "whale dumped / liquidity pulled" : "rug risk materialized",
      90,
      r.exitReason
    );
  }
  if (r.exitKind === "momentum_exit") {
    if (/buy pressure/i.test(r.exitReason)) add("buy pressure disappeared", 85, r.exitReason);
    else add("momentum faded", 85, r.exitReason);
  }
  if (r.exitKind === "weak_exit") add("momentum faded", 85, "no follow-through inside the weak-trade window");
  if (r.exitKind === "time_exit") add("momentum faded", 70, "went nowhere for the full hold window");
  if (r.exitKind === "breakeven_stop")
    add("momentum faded", 65, `peaked +${peaked.toFixed(1)}% then stalled — breakeven stop protected the trade`);

  if (r.exitKind === "stop_loss") {
    if (peaked < 2) {
      // never worked: entry quality problem
      if ((c.priceChange5mPct ?? 0) > 20)
        add("entered too late", 60 + Math.min(25, (c.priceChange5mPct ?? 0) / 2), `chased +${c.priceChange5mPct?.toFixed(0)}%/5m — likely fake breakout top`);
      if ((c.priceChange5mPct ?? 0) > 30) add("fake breakout", 70, `vertical +${c.priceChange5mPct?.toFixed(0)}%/5m candle reversed immediately`);
      if ((c.momentumAcceleration ?? 1) < 0)
        add("momentum already fading at entry", 75, `acceleration ${c.momentumAcceleration?.toFixed(2)} at entry`);
      if ((c.priceChange1hPct ?? 0) > 150)
        add("overextended move", 72, `already +${c.priceChange1hPct?.toFixed(0)}%/1h before entry`);
      if (causes.length === 0) add("market reversal", 55, "dropped straight to the stop with no prior gain");
    } else {
      add("market reversal", 65, `peaked +${peaked.toFixed(1)}% before reversing to the stop`);
      if ((c.volatility5m ?? 0) > 12 && r.stopLossPct <= 6)
        add("stop too tight for the volatility", 60, `volatility ${c.volatility5m?.toFixed(1)}% vs -${r.stopLossPct}% stop`);
    }
  }

  // Contributing factors (evidence-scaled confidence, capped as secondary)
  if (c.liquiditySol != null && c.liquiditySol < 25)
    add("liquidity too low", clamp(45 + (25 - c.liquiditySol)), `only ${c.liquiditySol.toFixed(0)} SOL pooled at entry`);
  if (c.estSlippagePctFor1Sol != null && c.estSlippagePctFor1Sol > 1.5)
    add("high slippage", clamp(40 + c.estSlippagePctFor1Sol * 10), `~${c.estSlippagePctFor1Sol.toFixed(1)}% est. slippage per SOL`);
  if (c.buySellRatio != null && c.buySellRatio < 1.2)
    add("weak buy pressure at entry", 55, `buy/sell only ${c.buySellRatio.toFixed(2)} at entry`);
  if ((r.entrySignals?.narrativeScore ?? null) != null && r.entrySignals!.narrativeScore! < 30)
    add("weak narrative", 50, `narrative score ${r.entrySignals!.narrativeScore}`);
  if (c.detectionToBuyMs != null && c.detectionToBuyMs > 120_000)
    add("poor execution / slow entry", 55, `${(c.detectionToBuyMs / 1000).toFixed(0)}s from detection to fill`);
  if (r.takeProfitPct / r.stopLossPct < 1.5)
    add("poor risk/reward configuration", 45, `target ${r.takeProfitPct}% vs stop ${r.stopLossPct}%`);

  if (causes.length === 0) add("unknown", 40, "no recorded signal explains this loss — flagged for manual review");
  return causes.sort((a, b) => b.confidencePct - a.confidencePct);
}

/** Generate + persist the review. Fire-and-forget from the engine. */
export async function generateTradeReview(r: ReviewInput): Promise<void> {
  try {
    const causes = deriveCauses(r);
    const tags = deriveTags(r);
    await prisma.tradeReview.upsert({
      where: { positionId: r.positionId },
      create: {
        positionId: r.positionId,
        mint: r.mint,
        symbol: r.symbol,
        paper: r.paper,
        win: r.pnlSol > 0,
        pnlSol: r.pnlSol,
        pnlPct: r.pnlPct,
        holdMinutes: r.holdMinutes,
        exitKind: r.exitKind || classifyExitKind(r.exitReason),
        snapshot: JSON.parse(
          JSON.stringify({
            entrySignals: r.entrySignals,
            exitReason: r.exitReason,
            maxUnrealizedPnlPct: r.maxUnrealizedPnlPct,
            maxDrawdownPct: r.maxDrawdownPct,
            takeProfitPct: r.takeProfitPct,
            stopLossPct: r.stopLossPct,
          })
        ),
        causes: JSON.parse(JSON.stringify(causes)),
        tags,
      },
      update: {}, // reviews are immutable once written
    });
    const top = causes[0];
    logger.info(
      "engine",
      `trade review ${r.mint.slice(0, 8)}…: ${r.pnlSol > 0 ? "WIN" : "LOSS"} ${r.pnlPct?.toFixed(1) ?? "?"}% — ${top.cause} (${top.confidencePct}%)`,
      { positionId: r.positionId, causes: causes.slice(0, 3).map((c) => `${c.cause} ${c.confidencePct}%`), tags }
    );
  } catch (e) {
    logger.warn("engine", `trade review failed for ${r.positionId}: ${(e as Error).message}`);
  }
}

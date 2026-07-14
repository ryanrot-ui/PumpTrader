import type { BotSettings } from "@/lib/validation";

export interface OpenPositionView {
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd: number; // highest price seen since entry
  openedAt: Date;
  now?: Date;
  /** live rug signals from the monitor */
  liquidityDropPct?: number | null; // negative = draining
  sellsFailing?: boolean;
  /** live momentum signals from the monitor (scalping exits) */
  buySellRatio5m?: number | null; // 5m buys / max(sells, 1)
  volume5mUsd?: number | null;
  entryVolume5mUsd?: number | null; // 5m volume when the position opened
}

export interface ExitDecision {
  exit: boolean;
  kind:
    | "take_profit"
    | "stop_loss"
    | "trailing_stop"
    | "time_exit"
    | "rug_exit"
    | "momentum_exit"
    | "weak_exit"
    | null;
  portionPct: number; // % of position to sell
  reason: string;
}

const HOLD: ExitDecision = { exit: false, kind: null, portionPct: 0, reason: "holding" };

/** Momentum exits get a short grace period so the entry's own buy doesn't
 *  trigger them before the market has printed a fresh 5m window. */
const MOMENTUM_GRACE_MS = 60_000;

/** Buy pressure above this while at the TP target = momentum still strong →
 *  defer the take profit and let the (tightened) trailing stop protect it. */
const STRONG_BUY_RATIO = 1.5;
/** …but never defer past this multiple of the TP target: bank extraordinary
 *  gains even if buyers keep coming (meme spikes retrace violently). */
const RUNNER_HARD_CAP_MULT = 3;

/**
 * Trailing distance for the current unrealized gain. With adaptiveTrailing
 * the trail *tightens* as profit grows, so a small winner gets room to
 * develop but a big winner is defended hard:
 *   gain < TP target      → base trail
 *   gain ≥ 1× TP target   → 0.75× base
 *   gain ≥ 2× TP target   → 0.5× base
 */
export function trailDistancePct(s: BotSettings, gainPct: number): number | null {
  if (s.trailingStopPct === null) return null;
  if (!s.adaptiveTrailing) return s.trailingStopPct;
  if (gainPct >= 2 * s.takeProfitPct) return s.trailingStopPct * 0.5;
  if (gainPct >= s.takeProfitPct) return s.trailingStopPct * 0.75;
  return s.trailingStopPct;
}

/**
 * Exit evaluation for one open position. Pure and deterministic.
 * Priority: rug exit > stop loss > momentum exits > weak-trade cut >
 * trailing stop > take profit > time exit.
 *
 * Philosophy: cut anything that isn't working (weak cut, momentum exits,
 * tight stop), and only stay in a trade while buyers are still paying up —
 * winners run behind an adaptive trail instead of being capped at the first
 * target when momentum is strong.
 */
export function evaluateExit(s: BotSettings, p: OpenPositionView): ExitDecision {
  const pnlPct = ((p.currentPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;

  // 1. Emergency rug exit — liquidity draining or sells failing
  if (p.sellsFailing) {
    return { exit: true, kind: "rug_exit", portionPct: 100, reason: "sells failing for other wallets — attempting emergency exit" };
  }
  if (
    p.liquidityDropPct !== null &&
    p.liquidityDropPct !== undefined &&
    p.liquidityDropPct <= -s.exitLiquidityDropPct
  ) {
    return {
      exit: true,
      kind: "rug_exit",
      portionPct: 100,
      reason: `liquidity dropped ${p.liquidityDropPct.toFixed(0)}% (limit ${s.exitLiquidityDropPct}%) — emergency exit`,
    };
  }

  // 2. Stop loss
  if (pnlPct <= -s.stopLossPct) {
    return {
      exit: true,
      kind: "stop_loss",
      portionPct: 100,
      reason: `stop loss: ${pnlPct.toFixed(1)}% ≤ -${s.stopLossPct}%`,
    };
  }

  // 3. Momentum exits (scalping): the setup died — leave before the dump,
  //    win or lose, instead of waiting for the stop loss to catch the fall.
  const heldMs = (p.now ?? new Date()).getTime() - p.openedAt.getTime();
  if (heldMs >= MOMENTUM_GRACE_MS) {
    if (
      s.exitMinBuySellRatio !== null &&
      p.buySellRatio5m !== null &&
      p.buySellRatio5m !== undefined &&
      p.buySellRatio5m < s.exitMinBuySellRatio
    ) {
      return {
        exit: true,
        kind: "momentum_exit",
        portionPct: 100,
        reason: `buy pressure faded: 5m buy/sell ${p.buySellRatio5m.toFixed(2)} < ${s.exitMinBuySellRatio} (pnl ${pnlPct.toFixed(1)}%)`,
      };
    }
    if (
      s.exitVolumeFadePct !== null &&
      p.volume5mUsd !== null &&
      p.volume5mUsd !== undefined &&
      p.entryVolume5mUsd !== null &&
      p.entryVolume5mUsd !== undefined &&
      p.entryVolume5mUsd > 0
    ) {
      const fadePct = (1 - p.volume5mUsd / p.entryVolume5mUsd) * 100;
      if (fadePct >= s.exitVolumeFadePct) {
        return {
          exit: true,
          kind: "momentum_exit",
          portionPct: 100,
          reason: `volume faded ${fadePct.toFixed(0)}% vs entry (limit ${s.exitVolumeFadePct}%) — momentum gone (pnl ${pnlPct.toFixed(1)}%)`,
        };
      }
    }
  }

  // 4. Weak-trade cut: the trade never worked — flat-to-losing after the
  //    configured window with buyers no longer in control. Don't hold losers
  //    hoping they recover; the capital belongs in the next setup.
  //    Requires real flow data: missing buy/sell data is neutral, never a
  //    trigger (same missing-data philosophy as the scoring engine).
  if (
    s.cutWeakAfterMinutes !== null &&
    heldMs >= s.cutWeakAfterMinutes * 60_000 &&
    p.buySellRatio5m !== null &&
    p.buySellRatio5m !== undefined &&
    p.buySellRatio5m < 1 &&
    pnlPct <= 1
  ) {
    return {
      exit: true,
      kind: "weak_exit",
      portionPct: 100,
      reason: `weak position: ${pnlPct.toFixed(1)}% after ${(heldMs / 60_000).toFixed(1)} min with buy/sell ${p.buySellRatio5m.toFixed(2)} — cutting instead of hoping`,
    };
  }

  // 5. Trailing stop (only once in profit, so it never fires before stop
  //    loss). Adaptive: the trail tightens as the gain grows.
  const peakGainPct = ((p.peakPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;
  const trail = trailDistancePct(s, peakGainPct);
  if (trail !== null && p.currentPriceUsd > p.entryPriceUsd) {
    const dropFromPeak = ((p.peakPriceUsd - p.currentPriceUsd) / p.peakPriceUsd) * 100;
    if (dropFromPeak >= trail) {
      return {
        exit: true,
        kind: "trailing_stop",
        portionPct: 100,
        reason: `trailing stop: ${dropFromPeak.toFixed(1)}% off peak (limit ${trail.toFixed(1)}%${s.adaptiveTrailing ? ", adaptive" : ""}), locking ${pnlPct.toFixed(1)}%`,
      };
    }
  }

  // 6. Take profit — adaptive: while buy pressure is still strong the target
  //    is deferred and the tightened trailing stop defends the gain (winners
  //    run); a hard cap at 3× the target banks extraordinary spikes anyway.
  if (pnlPct >= s.takeProfitPct) {
    const momentumStrong =
      s.letWinnersRun &&
      trail !== null && // deferring TP without a trail would be unprotected
      p.buySellRatio5m !== null &&
      p.buySellRatio5m !== undefined &&
      p.buySellRatio5m >= STRONG_BUY_RATIO;
    const hardCap = pnlPct >= s.takeProfitPct * RUNNER_HARD_CAP_MULT;
    if (!momentumStrong || hardCap) {
      return {
        exit: true,
        kind: "take_profit",
        portionPct: s.sellPortionPct,
        reason: hardCap
          ? `take profit (runner cap): +${pnlPct.toFixed(1)}% ≥ ${RUNNER_HARD_CAP_MULT}× the +${s.takeProfitPct}% target`
          : `take profit: +${pnlPct.toFixed(1)}% ≥ +${s.takeProfitPct}% target${s.letWinnersRun ? ` (buy pressure ${p.buySellRatio5m?.toFixed(2) ?? "unknown"} no longer strong)` : ""}`,
      };
    }
    // deferring: trailing stop above is the protection
  }

  // 7. Time-based exit
  if (s.maxHoldMinutes !== null) {
    const heldMin = heldMs / 60_000;
    if (heldMin >= s.maxHoldMinutes) {
      return {
        exit: true,
        kind: "time_exit",
        portionPct: 100,
        reason: `time exit: held ${heldMin.toFixed(0)} min ≥ ${s.maxHoldMinutes} min (pnl ${pnlPct.toFixed(1)}%)`,
      };
    }
  }

  return HOLD;
}

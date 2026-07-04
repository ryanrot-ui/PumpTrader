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
}

export interface ExitDecision {
  exit: boolean;
  kind: "take_profit" | "stop_loss" | "trailing_stop" | "time_exit" | "rug_exit" | null;
  portionPct: number; // % of position to sell
  reason: string;
}

const HOLD: ExitDecision = { exit: false, kind: null, portionPct: 0, reason: "holding" };

/**
 * Exit evaluation for one open position. Pure and deterministic.
 * Priority: rug exit > stop loss > trailing stop > take profit > time exit.
 * Default settings sell the entire position at +100%.
 */
export function evaluateExit(s: BotSettings, p: OpenPositionView): ExitDecision {
  const pnlPct = ((p.currentPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;

  // 1. Emergency rug exit — liquidity draining or sells failing
  if (p.sellsFailing) {
    return { exit: true, kind: "rug_exit", portionPct: 100, reason: "sells failing for other wallets — attempting emergency exit" };
  }
  if (p.liquidityDropPct !== null && p.liquidityDropPct !== undefined && p.liquidityDropPct <= -25) {
    return {
      exit: true,
      kind: "rug_exit",
      portionPct: 100,
      reason: `liquidity dropped ${p.liquidityDropPct.toFixed(0)}% — emergency exit`,
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

  // 3. Trailing stop (only once in profit, so it never fires before stop loss)
  if (s.trailingStopPct !== null && p.currentPriceUsd > p.entryPriceUsd) {
    const dropFromPeak = ((p.peakPriceUsd - p.currentPriceUsd) / p.peakPriceUsd) * 100;
    if (dropFromPeak >= s.trailingStopPct) {
      return {
        exit: true,
        kind: "trailing_stop",
        portionPct: 100,
        reason: `trailing stop: ${dropFromPeak.toFixed(1)}% off peak (limit ${s.trailingStopPct}%), locking ${pnlPct.toFixed(1)}%`,
      };
    }
  }

  // 4. Take profit
  if (pnlPct >= s.takeProfitPct) {
    return {
      exit: true,
      kind: "take_profit",
      portionPct: s.sellPortionPct,
      reason: `take profit: +${pnlPct.toFixed(1)}% ≥ +${s.takeProfitPct}% target`,
    };
  }

  // 5. Time-based exit
  if (s.maxHoldMinutes !== null) {
    const heldMin = ((p.now ?? new Date()).getTime() - p.openedAt.getTime()) / 60_000;
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

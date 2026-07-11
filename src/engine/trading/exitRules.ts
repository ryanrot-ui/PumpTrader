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
    | null;
  portionPct: number; // % of position to sell
  reason: string;
}

const HOLD: ExitDecision = { exit: false, kind: null, portionPct: 0, reason: "holding" };

/** Momentum exits get a short grace period so the entry's own buy doesn't
 *  trigger them before the market has printed a fresh 5m window. */
const MOMENTUM_GRACE_MS = 60_000;

/**
 * Exit evaluation for one open position. Pure and deterministic.
 * Priority: rug exit > stop loss > momentum exits > trailing stop >
 * take profit > time exit. Scalping defaults: +12% TP, -6% SL, 5% trail,
 * 10 min max hold, exit when buy pressure or volume fades.
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

  // 4. Trailing stop (only once in profit, so it never fires before stop loss)
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

  // 5. Take profit
  if (pnlPct >= s.takeProfitPct) {
    return {
      exit: true,
      kind: "take_profit",
      portionPct: s.sellPortionPct,
      reason: `take profit: +${pnlPct.toFixed(1)}% ≥ +${s.takeProfitPct}% target`,
    };
  }

  // 6. Time-based exit
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

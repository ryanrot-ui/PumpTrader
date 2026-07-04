import type { BotSettings } from "@/lib/validation";

export interface RiskState {
  openPositions: number;
  exposureSol: number; // SOL currently deployed in open positions
  dailyRealizedSol: number; // realized PnL today (negative = loss)
  lastLossAt: Date | null;
  emergencyStopped: boolean;
  now?: Date; // injectable for tests
}

export interface RiskDecision {
  allowed: boolean;
  /** actual SOL amount to use (buyAmount clamped by per-trade/exposure caps) */
  sizeSol: number;
  reasons: string[];
}

/**
 * Portfolio-level gate applied before any buy. Pure function — all state is
 * passed in, so it is deterministic and fully unit-testable.
 */
export function checkRisk(s: BotSettings, r: RiskState): RiskDecision {
  const reasons: string[] = [];
  const now = r.now ?? new Date();

  if (r.emergencyStopped) reasons.push("emergency stop is active");

  if (r.openPositions >= s.maxOpenPositions)
    reasons.push(`open positions ${r.openPositions} at limit ${s.maxOpenPositions}`);

  if (r.dailyRealizedSol <= -s.maxDailyLossSol)
    reasons.push(`daily loss ${(-r.dailyRealizedSol).toFixed(3)} SOL hit limit ${s.maxDailyLossSol}`);

  if (s.dailyProfitTarget !== null && r.dailyRealizedSol >= s.dailyProfitTarget)
    reasons.push(`daily profit target ${s.dailyProfitTarget} SOL reached — done for the day`);

  if (r.lastLossAt && s.lossCooldownMin > 0) {
    const elapsedMin = (now.getTime() - r.lastLossAt.getTime()) / 60_000;
    if (elapsedMin < s.lossCooldownMin)
      reasons.push(`in loss cooldown (${(s.lossCooldownMin - elapsedMin).toFixed(1)} min remaining)`);
  }

  const sizeSol = Math.min(s.buyAmountSol, s.maxSolPerTrade, s.maxExposureSol - r.exposureSol);
  if (sizeSol <= 0)
    reasons.push(`exposure ${r.exposureSol.toFixed(3)} SOL at cap ${s.maxExposureSol}`);

  return { allowed: reasons.length === 0, sizeSol: Math.max(0, sizeSol), reasons };
}

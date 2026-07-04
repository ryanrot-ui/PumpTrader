import type { BotSettings } from "@/lib/validation";
import type { ScoreResult, TokenMetrics } from "../analysis/types";

export interface BuyDecision {
  buy: boolean;
  reasons: string[]; // why it passed, or every rule it failed
}

/**
 * Hard buying rules, evaluated after scoring. All must pass.
 * Every failure is recorded so rejected tokens show exactly why.
 */
export function evaluateBuyRules(
  m: TokenMetrics,
  score: ScoreResult,
  s: BotSettings
): BuyDecision {
  const failures: string[] = [];

  if (score.criticalFlags.length > 0)
    failures.push(`critical red flag: ${score.criticalFlags.map((f) => f.label).join(", ")}`);

  if (score.total < s.confidenceThreshold)
    failures.push(`score ${score.total} below threshold ${s.confidenceThreshold}`);

  if (m.liquiditySol === null || m.liquiditySol < s.minLiquiditySol)
    failures.push(`liquidity ${m.liquiditySol?.toFixed(1) ?? "unknown"} SOL below minimum ${s.minLiquiditySol}`);

  if (m.marketCapUsd === null)
    failures.push("market cap unknown");
  else if (m.marketCapUsd < s.minMarketCapUsd || m.marketCapUsd > s.maxMarketCapUsd)
    failures.push(`market cap $${Math.round(m.marketCapUsd).toLocaleString()} outside [$${s.minMarketCapUsd.toLocaleString()}, $${s.maxMarketCapUsd.toLocaleString()}]`);

  if (m.holderCount === null || m.holderCount < s.minHolders)
    failures.push(`holders ${m.holderCount ?? "unknown"} below minimum ${s.minHolders}`);

  if (m.volume5mUsd === null || m.volume5mUsd < s.minVolume5mUsd)
    failures.push(`5m volume $${m.volume5mUsd?.toFixed(0) ?? "unknown"} below minimum $${s.minVolume5mUsd}`);

  if (m.volumeGrowthPct !== null && m.volumeGrowthPct < 0)
    failures.push(`volume trend negative (${m.volumeGrowthPct.toFixed(0)}%)`);

  if (m.momentum !== null && m.momentum <= 0)
    failures.push(`buy momentum not increasing (${m.momentum.toFixed(2)}%/min)`);

  if (m.estSlippagePctFor1Sol !== null && m.estSlippagePctFor1Sol * 100 > s.maxSlippageBps)
    failures.push(`estimated slippage ${m.estSlippagePctFor1Sol.toFixed(1)}% exceeds max ${(s.maxSlippageBps / 100).toFixed(1)}%`);

  if (failures.length > 0) return { buy: false, reasons: failures };

  return {
    buy: true,
    reasons: [
      `score ${score.total}/${s.confidenceThreshold} threshold`,
      ...score.greenFlags.slice(0, 6).map((f) => f.label.toLowerCase()),
    ],
  };
}

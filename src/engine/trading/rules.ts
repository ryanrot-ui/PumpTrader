import type { BotSettings } from "@/lib/validation";
import type { ScoreResult, TokenMetrics } from "../analysis/types";

export interface BuyDecision {
  buy: boolean;
  reasons: string[]; // why it passed, or every rule it failed
}

/** Narrative-intelligence scores relevant to the buy decision. */
export interface NarrativeGateInput {
  narrativeScore: number;
  memeScore: number;
  rugRiskScore: number;
}

/**
 * Hard buying rules, evaluated after scoring. All must pass.
 * Every failure is recorded so rejected tokens show exactly why.
 * Narrative gates apply only when the corresponding threshold is configured
 * — but a configured gate with MISSING narrative data fails closed.
 */
export function evaluateBuyRules(
  m: TokenMetrics,
  score: ScoreResult,
  s: BotSettings,
  narrative?: NarrativeGateInput | null
): BuyDecision {
  const failures: string[] = [];

  const narrativeGatesConfigured =
    s.minNarrativeScore !== null || s.minMemeScore !== null || s.maxRugRiskScore !== null;
  if (narrativeGatesConfigured && !narrative) {
    failures.push("narrative gates configured but narrative evaluation unavailable");
  }
  if (narrative) {
    if (s.minNarrativeScore !== null && narrative.narrativeScore < s.minNarrativeScore)
      failures.push(`narrative score ${narrative.narrativeScore} below minimum ${s.minNarrativeScore}`);
    if (s.minMemeScore !== null && narrative.memeScore < s.minMemeScore)
      failures.push(`meme strength ${narrative.memeScore} below minimum ${s.minMemeScore}`);
    if (s.maxRugRiskScore !== null && narrative.rugRiskScore > s.maxRugRiskScore)
      failures.push(`rug risk ${narrative.rugRiskScore} above maximum ${s.maxRugRiskScore}`);
  }

  if (score.criticalFlags.length > 0)
    failures.push(`critical red flag: ${score.criticalFlags.map((f) => f.label).join(", ")}`);

  if (score.total < s.confidenceThreshold)
    failures.push(`score ${score.total} below threshold ${s.confidenceThreshold}`);

  if (m.liquiditySol === null || m.liquiditySol < s.minLiquiditySol)
    failures.push(`liquidity ${m.liquiditySol?.toFixed(1) ?? "unknown"} SOL below minimum ${s.minLiquiditySol}`);

  if (s.maxLiquiditySol !== null && m.liquiditySol !== null && m.liquiditySol > s.maxLiquiditySol)
    failures.push(`liquidity ${m.liquiditySol.toFixed(1)} SOL above maximum ${s.maxLiquiditySol}`);

  if (m.marketCapUsd === null)
    failures.push("market cap unknown");
  else if (m.marketCapUsd < s.minMarketCapUsd || m.marketCapUsd > s.maxMarketCapUsd)
    failures.push(`market cap $${Math.round(m.marketCapUsd).toLocaleString()} outside [$${s.minMarketCapUsd.toLocaleString()}, $${s.maxMarketCapUsd.toLocaleString()}]`);

  if (m.holderCount === null || m.holderCount < s.minHolders)
    failures.push(`holders ${m.holderCount ?? "unknown"} below minimum ${s.minHolders}`);

  if (m.volume5mUsd === null || m.volume5mUsd < s.minVolume5mUsd)
    failures.push(`5m volume $${m.volume5mUsd?.toFixed(0) ?? "unknown"} below minimum $${s.minVolume5mUsd}`);

  if (m.buySellRatio === null || m.buySellRatio < s.minBuyPressure)
    failures.push(`buy pressure ${m.buySellRatio?.toFixed(2) ?? "unknown"} below minimum ${s.minBuyPressure}`);

  if (m.topHolderPct !== null && m.topHolderPct > s.maxWhalePct)
    failures.push(`top holder ${m.topHolderPct.toFixed(1)}% exceeds max whale ${s.maxWhalePct}%`);

  if (m.devWalletPct !== null && m.devWalletPct > s.maxDevPct)
    failures.push(`dev holds ${m.devWalletPct.toFixed(1)}% exceeding max ${s.maxDevPct}%`);

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
      ...(narrative
        ? [
            `narrative ${narrative.narrativeScore}, meme ${narrative.memeScore}, rug risk ${narrative.rugRiskScore}`,
          ]
        : []),
      ...score.greenFlags.slice(0, 6).map((f) => f.label.toLowerCase()),
    ],
  };
}

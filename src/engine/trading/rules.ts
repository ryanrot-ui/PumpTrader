import type { BotSettings } from "@/lib/validation";
import type { ScoreResult, TokenMetrics } from "../analysis/types";

/**
 * Three-layer execution decision. Meme-coin risk is priced, not banned:
 *
 *  1. SAFETY (hard gates)   — conditions that indicate a likely scam or a
 *     fundamentally unsafe trade. Any failure → IGNORE. Nothing else can
 *     hard-reject a token.
 *  2. OPPORTUNITY (score)   — the 0–100 technical score vs the operator's
 *     confidenceThreshold. Below threshold → WATCH (keep monitoring), not
 *     ignore.
 *  3. RISK ADVISORIES (soft)— concentrated holders, thin volume, weak buy
 *     pressure, dev holdings, market-cap bounds, momentum, narrative/meme
 *     minimums. These NEVER reject on their own — they are recorded in the
 *     decision trace (and already depress the opportunity score via the
 *     scoring engine), so the operator can tune thresholds over time.
 *
 * Every rule evaluated — passed or failed, hard or advisory — is returned in
 * `trace`, so the dashboard can show the complete reasoning for any verdict.
 */

export type ExecutionAction = "buy" | "watch" | "ignore";

export interface RuleResult {
  rule: string;
  layer: "safety" | "opportunity" | "risk";
  /** Hard rules can reject; advisory rules only inform (and shape the score). */
  hard: boolean;
  passed: boolean;
  detail: string;
}

export interface BuyDecision {
  buy: boolean;
  action: ExecutionAction;
  /** Hard failures (action=ignore), the score shortfall (watch), or the pass summary (buy). */
  reasons: string[];
  /** Soft advisories that did not block the trade. */
  warnings: string[];
  /** Every rule evaluated, for full dashboard transparency. */
  trace: RuleResult[];
  /** 0–100: share of decision inputs that actually had data. */
  confidence: number;
}

/** Narrative-intelligence scores relevant to the buy decision. */
export interface NarrativeGateInput {
  narrativeScore: number;
  memeScore: number;
  rugRiskScore: number;
}

/** Share of the inputs the decision runs on that were actually available. */
function dataConfidence(m: TokenMetrics): number {
  const inputs: Array<unknown> = [
    m.priceUsd,
    m.liquiditySol,
    m.marketCapUsd,
    m.volume5mUsd,
    m.buySellRatio,
    m.holderCount,
    m.topHolderPct,
    m.devWalletPct,
    m.momentum,
    m.mintAuthorityRevoked,
    m.freezeAuthorityRevoked,
  ];
  const present = inputs.filter((v) => v !== null && v !== undefined).length;
  return Math.round((present / inputs.length) * 100);
}

export function evaluateBuyRules(
  m: TokenMetrics,
  score: ScoreResult,
  s: BotSettings,
  narrative?: NarrativeGateInput | null
): BuyDecision {
  const trace: RuleResult[] = [];
  const add = (
    layer: RuleResult["layer"],
    hard: boolean,
    rule: string,
    passed: boolean,
    detail: string
  ) => trace.push({ rule, layer, hard, passed, detail });

  // ── Layer 1: SAFETY — likely-scam / fundamentally unsafe only ────────────
  add(
    "safety",
    true,
    "honeypot",
    m.isHoneypotSuspected !== true,
    m.isHoneypotSuspected === true
      ? "sells are consistently failing — honeypot suspected"
      : m.isHoneypotSuspected === false
        ? "sells execute normally"
        : "no honeypot signal observed"
  );
  add(
    "safety",
    true,
    "freeze authority",
    m.freezeAuthorityRevoked !== false,
    m.freezeAuthorityRevoked === false
      ? "freeze authority still enabled — transfers can be frozen"
      : m.freezeAuthorityRevoked === true
        ? "freeze authority revoked"
        : "freeze authority unknown (not hard-failed; lowers confidence)"
  );
  add(
    "safety",
    true,
    "mint authority",
    m.mintAuthorityRevoked !== false,
    m.mintAuthorityRevoked === false
      ? "mint authority still enabled — supply can be inflated"
      : m.mintAuthorityRevoked === true
        ? "mint authority revoked"
        : "mint authority unknown (not hard-failed; lowers confidence)"
  );
  if (score.criticalFlags.length > 0) {
    add(
      "safety",
      true,
      "critical flags",
      false,
      `critical red flag: ${score.criticalFlags.map((f) => f.label).join(", ")}`
    );
  } else {
    add("safety", true, "critical flags", true, "no critical red flags");
  }
  add(
    "safety",
    true,
    "minimum liquidity",
    m.liquiditySol !== null && m.liquiditySol >= s.minLiquiditySol,
    `liquidity ${m.liquiditySol?.toFixed(1) ?? "unknown"} SOL vs configured minimum ${s.minLiquiditySol} SOL${m.liquiditySol === null ? " (unknown fails closed — a trade needs a priced exit)" : ""}`
  );
  if (s.maxLiquiditySol !== null) {
    add(
      "safety",
      true,
      "maximum liquidity",
      m.liquiditySol === null || m.liquiditySol <= s.maxLiquiditySol,
      `liquidity ${m.liquiditySol?.toFixed(1) ?? "unknown"} SOL vs configured maximum ${s.maxLiquiditySol} SOL`
    );
  }
  if (s.maxRugRiskScore !== null) {
    const rugOk = narrative ? narrative.rugRiskScore <= s.maxRugRiskScore : false;
    add(
      "safety",
      true,
      "rug risk",
      rugOk,
      narrative
        ? `rug-risk estimate ${narrative.rugRiskScore} vs configured maximum ${s.maxRugRiskScore}`
        : "rug-risk gate configured but narrative evaluation unavailable (fails closed)"
    );
  }
  add(
    "safety",
    true,
    "slippage",
    m.estSlippagePctFor1Sol === null || m.estSlippagePctFor1Sol * 100 <= s.maxSlippageBps,
    m.estSlippagePctFor1Sol !== null
      ? `estimated slippage ${m.estSlippagePctFor1Sol.toFixed(1)}% vs max ${(s.maxSlippageBps / 100).toFixed(1)}%`
      : "slippage estimate unavailable"
  );
  // Entry timing (anti-chase): a move that already happened is not a setup —
  // buying it is exit liquidity. These are hard gates because a late entry
  // structurally inverts the reward/risk the exits are tuned for.
  if (s.maxEntryPriceChange5mPct !== null) {
    add(
      "safety",
      true,
      "entry timing (5m)",
      m.priceChange5mPct === null || m.priceChange5mPct <= s.maxEntryPriceChange5mPct,
      m.priceChange5mPct !== null
        ? `price ${m.priceChange5mPct >= 0 ? "+" : ""}${m.priceChange5mPct.toFixed(0)}% in 5m vs chase limit +${s.maxEntryPriceChange5mPct}%`
        : "5m price change unknown"
    );
  }
  if (s.maxEntryPriceChange1hPct !== null) {
    add(
      "safety",
      true,
      "entry timing (1h)",
      m.priceChange1hPct === null || m.priceChange1hPct <= s.maxEntryPriceChange1hPct,
      m.priceChange1hPct !== null
        ? `price ${m.priceChange1hPct >= 0 ? "+" : ""}${m.priceChange1hPct.toFixed(0)}% in 1h vs exhaustion limit +${s.maxEntryPriceChange1hPct}% — biggest move likely already made`
        : "1h price change unknown"
    );
  }
  if (s.requireRisingMomentum) {
    add(
      "safety",
      true,
      "rising momentum",
      m.momentumAcceleration !== null && m.momentumAcceleration > 0,
      m.momentumAcceleration !== null
        ? `momentum acceleration ${m.momentumAcceleration.toFixed(2)} (must be > 0: buy moves that are building, not fading)`
        : "momentum acceleration unknown (fails closed while requireRisingMomentum is on)"
    );
  }

  // ── Layer 2: OPPORTUNITY — score vs threshold ────────────────────────────
  const scoreOk = score.total >= s.confidenceThreshold;
  add(
    "opportunity",
    false,
    "opportunity score",
    scoreOk,
    `score ${score.total}/100 vs acceptance threshold ${s.confidenceThreshold}`
  );

  // ── Layer 3: RISK ADVISORIES — inform and tune, never reject ─────────────
  const advisory = (rule: string, passed: boolean, detail: string) =>
    add("risk", false, rule, passed, detail);

  advisory(
    "holders",
    m.holderCount !== null && m.holderCount >= s.minHolders,
    `holders ${m.holderCount ?? "unknown"} vs preferred minimum ${s.minHolders}`
  );
  advisory(
    "5m volume",
    m.volume5mUsd !== null && m.volume5mUsd >= s.minVolume5mUsd,
    `5m volume $${m.volume5mUsd?.toFixed(0) ?? "unknown"} vs preferred minimum $${s.minVolume5mUsd}`
  );
  advisory(
    "buy pressure",
    m.buySellRatio !== null && m.buySellRatio >= s.minBuyPressure,
    `buy/sell ratio ${m.buySellRatio?.toFixed(2) ?? "unknown"} vs preferred minimum ${s.minBuyPressure}`
  );
  advisory(
    "whale concentration",
    m.topHolderPct === null || m.topHolderPct <= s.maxWhalePct,
    `top holder ${m.topHolderPct?.toFixed(1) ?? "unknown"}% vs preferred maximum ${s.maxWhalePct}%`
  );
  advisory(
    "dev holdings",
    m.devWalletPct === null || m.devWalletPct <= s.maxDevPct,
    `dev holds ${m.devWalletPct?.toFixed(1) ?? "unknown"}% vs preferred maximum ${s.maxDevPct}%`
  );
  advisory(
    "market cap",
    m.marketCapUsd !== null &&
      m.marketCapUsd >= s.minMarketCapUsd &&
      m.marketCapUsd <= s.maxMarketCapUsd,
    m.marketCapUsd !== null
      ? `market cap $${Math.round(m.marketCapUsd).toLocaleString()} vs preferred [$${s.minMarketCapUsd.toLocaleString()}, $${s.maxMarketCapUsd.toLocaleString()}]`
      : "market cap unknown"
  );
  advisory(
    "volume trend",
    m.volumeGrowthPct === null || m.volumeGrowthPct >= 0,
    `volume trend ${m.volumeGrowthPct?.toFixed(0) ?? "unknown"}%`
  );
  advisory(
    "momentum",
    m.momentum === null || m.momentum > 0,
    `momentum ${m.momentum?.toFixed(2) ?? "unknown"}%/min`
  );
  advisory(
    "momentum building",
    m.momentumAcceleration === null || m.momentumAcceleration >= 0,
    `momentum acceleration ${m.momentumAcceleration?.toFixed(2) ?? "unknown"} (prefer entries while the move is building)`
  );
  advisory(
    "holder growth",
    m.holderGrowth5m === null || m.holderGrowth5m > 0,
    `holder growth ${m.holderGrowth5m ?? "unknown"}/5m (prefer early holder growth before the move)`
  );
  if (s.minNarrativeScore !== null) {
    advisory(
      "narrative",
      narrative != null && narrative.narrativeScore >= s.minNarrativeScore,
      narrative
        ? `narrative score ${narrative.narrativeScore} vs preferred minimum ${s.minNarrativeScore}`
        : "narrative evaluation unavailable"
    );
  }
  if (s.minMemeScore !== null) {
    advisory(
      "meme strength",
      narrative != null && narrative.memeScore >= s.minMemeScore,
      narrative
        ? `meme strength ${narrative.memeScore} vs preferred minimum ${s.minMemeScore}`
        : "narrative evaluation unavailable"
    );
  }

  // ── Decision ──────────────────────────────────────────────────────────────
  const hardFailures = trace.filter((r) => r.hard && !r.passed);
  const warnings = trace.filter((r) => !r.hard && !r.passed && r.layer === "risk").map((r) => `${r.rule}: ${r.detail}`);
  const confidence = dataConfidence(m);

  if (hardFailures.length > 0) {
    return {
      buy: false,
      action: "ignore",
      reasons: hardFailures.map((r) => r.detail),
      warnings,
      trace,
      confidence,
    };
  }

  if (!scoreOk) {
    return {
      buy: false,
      action: "watch",
      reasons: [`score ${score.total} below acceptance threshold ${s.confidenceThreshold} — safe but not attractive enough yet; still monitoring`],
      warnings,
      trace,
      confidence,
    };
  }

  return {
    buy: true,
    action: "buy",
    reasons: [
      `score ${score.total} ≥ threshold ${s.confidenceThreshold}; all safety gates passed`,
      ...(narrative
        ? [`narrative ${narrative.narrativeScore}, meme ${narrative.memeScore}, rug risk ${narrative.rugRiskScore}`]
        : []),
      ...score.greenFlags.slice(0, 6).map((f) => f.label.toLowerCase()),
    ],
    warnings,
    trace,
    confidence,
  };
}

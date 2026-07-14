import { prisma } from "@/lib/prisma";
import type { TokenMetrics } from "../analysis/types";
import { logger } from "../logging/logger";
import { collectDexSocial } from "./providers/dexscreenerSocial";
import { collectReddit } from "./providers/reddit";
import { collectTelegramMembers } from "./providers/telegram";
import { collectXMentions } from "./providers/x";
import { assessMemeQuality, memeAiEnabled } from "./providers/memeAI";
import { computeMemeScore, computeNarrativeScore } from "./aggregate";
import { assessRugRisk } from "./rugRisk";
import { matchTokenToNarratives, trendScoreAdjustment, type NarrativeLite } from "./trends";
import {
  DEFAULT_NARRATIVE_WEIGHTS,
  type MemeAssessment,
  type NarrativeReport,
  type NarrativeWeights,
  type SocialSignals,
} from "./types";

/**
 * Narrative Intelligence Engine — researches every token before a trade is
 * considered by combining independent public signals (DexScreener social
 * profile + boosts, Reddit search, Telegram community size, optional X
 * counts, optional AI meme assessment) with on-chain rug indicators.
 *
 * Design constraints:
 *  - graceful degradation: any provider failing → nulls → neutral scores
 *  - transparency: every factor's value, weight and detail is persisted
 *  - cost control: results cached per mint (EVAL_TTL); the AI meme
 *    assessment runs at most once per token
 */

const EVAL_TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  report: NarrativeReport;
}

export class NarrativeEngine {
  private cache = new Map<string, CacheEntry>();
  private memeAiCache = new Map<string, MemeAssessment | null>();
  private inflight = new Map<string, Promise<NarrativeReport>>();

  constructor(
    private getWeights: () => NarrativeWeights | null = () => null,
    /** active trending narratives (from the TrendTracker); [] = trends off */
    private getTrends: () => NarrativeLite[] = () => []
  ) {}

  /** Cached evaluation; safe to call on every scanner tick. */
  async evaluate(tokenId: string, metrics: TokenMetrics): Promise<NarrativeReport> {
    const cached = this.cache.get(metrics.mint);
    if (cached && Date.now() - cached.at < EVAL_TTL_MS) return cached.report;

    const inflight = this.inflight.get(metrics.mint);
    if (inflight) return inflight;

    const task = this.evaluateFresh(tokenId, metrics).finally(() =>
      this.inflight.delete(metrics.mint)
    );
    this.inflight.set(metrics.mint, task);
    return task;
  }

  private async evaluateFresh(
    tokenId: string,
    metrics: TokenMetrics
  ): Promise<NarrativeReport> {
    const missingSources: string[] = [];

    // Independent providers in parallel; each degrades to null on failure.
    const [dex, reddit, prevSnapshot] = await Promise.all([
      collectDexSocial(metrics.mint),
      collectReddit(metrics.symbol, metrics.name),
      prisma.narrativeSnapshot.findFirst({
        where: { tokenId },
        orderBy: { at: "desc" },
        select: { telegramMembers: true },
      }).catch(() => null),
    ]);
    if (!dex) missingSources.push("dexscreener-social");
    if (!reddit) missingSources.push("reddit");

    const [telegramMembers, xMentions] = await Promise.all([
      collectTelegramMembers(dex?.telegramHandle ?? null),
      collectXMentions(metrics.symbol),
    ]);
    if (dex?.hasTelegram && telegramMembers === null) missingSources.push("telegram");
    if (!process.env.TWITTER_BEARER_TOKEN) missingSources.push("x (not configured)");

    const signals: SocialSignals = {
      hasTwitter: dex?.hasTwitter ?? false,
      hasTelegram: dex?.hasTelegram ?? false,
      hasWebsite: dex?.hasWebsite ?? false,
      telegramHandle: dex?.telegramHandle ?? null,
      boostsActive: dex?.boostsActive ?? null,
      description: null,
      txnAcceleration: dex?.txnAcceleration ?? null,
      volumeAcceleration: dex?.volumeAcceleration ?? null,
      redditPosts24h: reddit?.posts24h ?? null,
      redditPostsPrior6d: reddit?.postsPrior6d ?? null,
      redditEngagement: reddit?.engagement ?? null,
      redditSentiment: reddit?.sentiment ?? null,
      telegramMembers,
      telegramMembersPrev: prevSnapshot?.telegramMembers ?? null,
      xMentions24h: xMentions,
      missingSources,
    };

    // AI meme assessment: once per token, cached for the token's lifetime.
    let memeAssessment = this.memeAiCache.get(metrics.mint);
    if (memeAssessment === undefined && memeAiEnabled()) {
      memeAssessment = await assessMemeQuality(
        metrics.symbol,
        metrics.name ?? dex?.tokenName ?? null,
        signals
      );
      this.memeAiCache.set(metrics.mint, memeAssessment);
      if (this.memeAiCache.size > 5000) this.memeAiCache.clear();
    }
    memeAssessment ??= null;

    const weights = this.getWeights() ?? DEFAULT_NARRATIVE_WEIGHTS;
    const narrative = computeNarrativeScore(signals, weights);
    const meme = computeMemeScore(signals, memeAssessment);
    const rug = assessRugRisk(metrics);

    // Trend intelligence: does this token match an emerging narrative? A
    // fresh, growing, cross-platform match earns a bounded bonus (max +17);
    // a match whose trend already peaked is a PENALTY. Never a buy signal
    // on its own — it only shifts the narrative score, which the trade
    // decision treats as one gated input among many.
    const match = matchTokenToNarratives(
      metrics.name ?? dex?.tokenName ?? null,
      metrics.symbol,
      this.getTrends()
    );
    const trendAdj = trendScoreAdjustment(match);
    const narrativeScore = Math.max(0, Math.min(100, narrative.score + trendAdj.delta));

    const bullishFactors = narrative.factors
      .filter((f) => f.value >= 0.65)
      .map((f) => `${f.name}: ${f.detail}`);
    const bearishFactors = [
      ...narrative.factors.filter((f) => f.value <= 0.35).map((f) => `${f.name}: ${f.detail}`),
      ...rug.factors.filter((f) => f.value >= 0.75).map((f) => `rug risk — ${f.name}: ${f.detail}`),
    ];
    if (match && trendAdj.delta > 0) bullishFactors.unshift(`narrative match: ${trendAdj.detail}`);
    if (match && trendAdj.delta < 0) bearishFactors.unshift(`narrative peaked: ${trendAdj.detail}`);
    if ((signals.boostsActive ?? 0) > 0) {
      bearishFactors.push(`paid promotion: ${signals.boostsActive} DexScreener boost(s) active`);
    }

    const report: NarrativeReport = {
      memeScore: meme.score,
      narrativeScore,
      rugRiskScore: rug.score,
      sentiment: signals.redditSentiment,
      bullishFactors,
      bearishFactors,
      memeExplanation: meme.explanation,
      narrativeExplanation:
        narrative.explanation + (match ? ` Trend: ${trendAdj.detail} (${trendAdj.delta >= 0 ? "+" : ""}${trendAdj.delta}).` : ""),
      rugExplanation: rug.explanation,
      narrativeFactors: narrative.factors,
      rugFactors: rug.factors,
      signals,
      memeAssessment,
      trendMatch: match ? { ...match, scoreDelta: trendAdj.delta, detail: trendAdj.detail } : null,
    };

    this.cache.set(metrics.mint, { at: Date.now(), report });
    if (this.cache.size > 5000) this.cache.clear();

    await this.persist(tokenId, report).catch((e) =>
      logger.warn("scoring", `narrative snapshot persist failed: ${(e as Error).message}`)
    );
    return report;
  }

  private async persist(tokenId: string, r: NarrativeReport): Promise<void> {
    await prisma.$transaction([
      prisma.narrativeSnapshot.create({
        data: {
          tokenId,
          redditPosts24h: r.signals.redditPosts24h,
          redditEngagement: r.signals.redditEngagement,
          telegramMembers: r.signals.telegramMembers,
          xMentions24h: r.signals.xMentions24h,
          boostsActive: r.signals.boostsActive,
          hasTwitter: r.signals.hasTwitter,
          hasTelegram: r.signals.hasTelegram,
          hasWebsite: r.signals.hasWebsite,
          memeScore: r.memeScore,
          narrativeScore: r.narrativeScore,
          rugRiskScore: r.rugRiskScore,
          sentiment: r.sentiment,
          report: JSON.parse(
            JSON.stringify({
              bullishFactors: r.bullishFactors,
              bearishFactors: r.bearishFactors,
              meme: r.memeExplanation,
              narrative: r.narrativeExplanation,
              rug: r.rugExplanation,
              narrativeFactors: r.narrativeFactors,
              rugFactors: r.rugFactors,
              memeAssessment: r.memeAssessment,
              trendMatch: r.trendMatch,
              missingSources: r.signals.missingSources,
            })
          ),
        },
      }),
      prisma.detectedToken.update({
        where: { id: tokenId },
        data: {
          narrativeScore: r.narrativeScore,
          memeScore: r.memeScore,
          rugRiskScore: r.rugRiskScore,
        },
      }),
    ]);
  }

  /** Drop a token from the caches (watchlist expiry / after buying). */
  forget(mint: string): void {
    this.cache.delete(mint);
  }
}

/** Compact snapshot of entry-time signals stored on the Position row. */
export function entrySignalsPayload(scannerScore: number, r: NarrativeReport) {
  return {
    scannerScore,
    narrativeScore: r.narrativeScore,
    memeScore: r.memeScore,
    rugRiskScore: r.rugRiskScore,
    sentiment: r.sentiment,
    redditPosts24h: r.signals.redditPosts24h,
    telegramMembers: r.signals.telegramMembers,
    xMentions24h: r.signals.xMentions24h,
    boosted: (r.signals.boostsActive ?? 0) > 0,
    hasTwitter: r.signals.hasTwitter,
    hasTelegram: r.signals.hasTelegram,
    bullishFactors: r.bullishFactors,
    bearishFactors: r.bearishFactors,
    // per-trade narrative explanation: which narrative matched, why, who
    // drove it, and whether it was growing or already fading at entry
    trendMatch: r.trendMatch,
  };
}

import type {
  FactorReading,
  MemeAssessment,
  NarrativeWeights,
  SocialSignals,
} from "./types";

/**
 * Score aggregation — pure functions so every score is unit-testable and
 * fully explainable. Missing data scores neutral (0.5) and is labeled so;
 * it never counts in a token's favor.
 */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Map a value onto 0..1 between a "poor" and "excellent" anchor. */
const ramp = (value: number, poor: number, excellent: number): number =>
  clamp01((value - poor) / (excellent - poor));

export function narrativeFactors(
  s: SocialSignals,
  weights: NarrativeWeights
): FactorReading[] {
  const factors: FactorReading[] = [];

  // Social presence: has the team even set up channels?
  const presence = [s.hasTwitter, s.hasTelegram, s.hasWebsite].filter(Boolean).length;
  factors.push({
    name: "social presence",
    value: presence / 3,
    weight: weights.socialPresence,
    detail: `${presence}/3 channels (twitter:${s.hasTwitter} telegram:${s.hasTelegram} web:${s.hasWebsite})`,
  });

  // Attention velocity from market activity (always available)
  const accel =
    s.txnAcceleration !== null || s.volumeAcceleration !== null
      ? Math.max(s.txnAcceleration ?? 0, s.volumeAcceleration ?? 0)
      : null;
  factors.push({
    name: "attention velocity",
    value: accel === null ? 0.5 : ramp(accel, 0.5, 3),
    weight: weights.attentionVelocity,
    detail:
      accel === null
        ? "no activity data"
        : `current activity ${accel.toFixed(1)}× the trailing rate`,
  });

  // Mention velocity: Reddit (+X when configured)
  let mentionValue = 0.5;
  let mentionDetail = "no mention data (Reddit unreachable, X not configured)";
  if (s.redditPosts24h !== null) {
    const baselinePerDay = (s.redditPostsPrior6d ?? 0) / 6;
    const velocity =
      baselinePerDay > 0 ? s.redditPosts24h / baselinePerDay : s.redditPosts24h > 0 ? 3 : 0;
    const volume = ramp(s.redditPosts24h, 0, 15);
    mentionValue = clamp01(0.5 * volume + 0.5 * ramp(velocity, 0.5, 3));
    mentionDetail = `${s.redditPosts24h} Reddit posts/24h (${velocity.toFixed(1)}× the prior-week rate)`;
  }
  if (s.xMentions24h !== null) {
    mentionValue = clamp01(0.6 * mentionValue + 0.4 * ramp(s.xMentions24h, 0, 200));
    mentionDetail += ` · ${s.xMentions24h} X mentions/24h`;
  }
  factors.push({
    name: "mention velocity",
    value: mentionValue,
    weight: weights.mentionVelocity,
    detail: mentionDetail,
  });

  // Engagement quality
  factors.push({
    name: "engagement",
    value:
      s.redditEngagement === null
        ? 0.5
        : s.redditPosts24h && s.redditPosts24h > 0
          ? ramp(s.redditEngagement / Math.max(s.redditPosts24h, 1), 1, 40)
          : 0.2,
    weight: weights.engagement,
    detail:
      s.redditEngagement === null
        ? "no engagement data"
        : `${s.redditEngagement} upvotes+comments across recent posts`,
  });

  // Community growth (Telegram members between snapshots)
  let growthValue = 0.5;
  let growthDetail = "no community-size data";
  if (s.telegramMembers !== null) {
    if (s.telegramMembersPrev !== null && s.telegramMembersPrev > 0) {
      const growthPct =
        ((s.telegramMembers - s.telegramMembersPrev) / s.telegramMembersPrev) * 100;
      growthValue = ramp(growthPct, -5, 25);
      growthDetail = `Telegram ${s.telegramMembers.toLocaleString()} members (${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}% since last check)`;
    } else {
      growthValue = ramp(s.telegramMembers, 50, 3000);
      growthDetail = `Telegram ${s.telegramMembers.toLocaleString()} members (no growth baseline yet)`;
    }
  }
  factors.push({
    name: "community growth",
    value: growthValue,
    weight: weights.communityGrowth,
    detail: growthDetail,
  });

  // Cross-platform confirmation: independent sources agreeing
  const activeSources = [
    (s.redditPosts24h ?? 0) > 0,
    (s.telegramMembers ?? 0) > 100,
    (s.xMentions24h ?? 0) > 5,
    (accel ?? 0) > 1.2,
  ].filter(Boolean).length;
  factors.push({
    name: "cross-platform confirmation",
    value: activeSources / 4,
    weight: weights.crossPlatform,
    detail: `${activeSources}/4 independent signals active`,
  });

  // Sentiment
  factors.push({
    name: "sentiment",
    value: s.redditSentiment === null ? 0.5 : (s.redditSentiment + 1) / 2,
    weight: weights.sentiment,
    detail:
      s.redditSentiment === null
        ? "no sentiment data"
        : `title sentiment ${s.redditSentiment >= 0 ? "+" : ""}${s.redditSentiment.toFixed(2)} (-1..1)`,
  });

  return factors;
}

export function computeNarrativeScore(
  s: SocialSignals,
  weights: NarrativeWeights
): { score: number; factors: FactorReading[]; explanation: string } {
  const factors = narrativeFactors(s, weights);
  const totalWeight = factors.reduce((a, f) => a + f.weight, 0);
  let score = Math.round(
    (factors.reduce((a, f) => a + f.value * f.weight, 0) / totalWeight) * 100
  );

  // Paid promotion caps organic credibility: boosted listings can't score
  // as if the attention were organic.
  let boostNote = "";
  if ((s.boostsActive ?? 0) > 0 && score > 65) {
    score = 65;
    boostNote = ` Score capped at 65: ${s.boostsActive} paid DexScreener boost(s) active — attention may not be organic.`;
  }

  const ranked = [...factors].sort(
    (a, b) => b.value * b.weight - a.value * a.weight
  );
  const explanation =
    `Narrative ${score}/100. Strongest: ${ranked[0].name} (${ranked[0].detail}); ` +
    `weakest: ${ranked[ranked.length - 1].name} (${ranked[ranked.length - 1].detail}).` +
    boostNote;

  return { score, factors, explanation };
}

/**
 * Meme strength 0–100. With the AI assessment available it contributes 60%
 * (originality/humor/trend/branding); the observable "is it actually
 * spreading" heuristics always contribute the rest, so a great-looking meme
 * nobody shares cannot score highly on hype alone — and vice versa.
 */
export function computeMemeScore(
  s: SocialSignals,
  ai: MemeAssessment | null
): { score: number; explanation: string } {
  const discussion = ramp(s.redditPosts24h ?? 0, 0, 10);
  const acceleration = ramp(Math.max(s.txnAcceleration ?? 0, s.volumeAcceleration ?? 0), 0.8, 3);
  const community = ramp(s.telegramMembers ?? 0, 0, 2000);
  const organic = (s.boostsActive ?? 0) > 0 ? 0.3 : 0.7; // paid promo ≠ organic spread
  const spreading = (discussion * 0.35 + acceleration * 0.3 + community * 0.2 + organic * 0.15) * 100;

  if (!ai) {
    const score = Math.round(spreading);
    return {
      score,
      explanation:
        `Meme strength ${score}/100 from spread signals only (AI assessment not configured): ` +
        `${s.redditPosts24h ?? 0} posts/24h, activity ${(s.txnAcceleration ?? 0).toFixed(1)}×, ` +
        `${s.telegramMembers?.toLocaleString() ?? "?"} TG members${(s.boostsActive ?? 0) > 0 ? ", paid boost active" : ""}.`,
    };
  }

  const quality =
    ai.originality * 0.3 + ai.humor * 0.25 + ai.trendRelevance * 0.25 + ai.brandAppeal * 0.2;
  const score = Math.round(quality * 0.6 + spreading * 0.4);
  return {
    score,
    explanation:
      `Meme strength ${score}/100 — quality ${Math.round(quality)} (originality ${ai.originality}, ` +
      `humor ${ai.humor}, trend ${ai.trendRelevance}, branding ${ai.brandAppeal}) × spread ${Math.round(spreading)}. ` +
      ai.reasoning,
  };
}

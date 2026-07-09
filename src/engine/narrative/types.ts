/**
 * Narrative & social intelligence types.
 *
 * Every raw signal may be null (source unavailable / not configured); the
 * aggregator scores missing data as neutral — never in a token's favor —
 * and records what was missing so every score is explainable.
 */

export interface SocialSignals {
  // DexScreener token profile
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  telegramHandle: string | null;
  boostsActive: number | null; // paid DexScreener promotion (a caution signal)
  description: string | null;

  // Attention / activity from market data (windowed)
  txnAcceleration: number | null; // (m5 tx rate) / (h1 tx rate); >1 = accelerating
  volumeAcceleration: number | null; // (m5 vol rate) / (h6 vol rate)

  // Reddit (public search API)
  redditPosts24h: number | null;
  redditPostsPrior6d: number | null; // baseline for mention velocity
  redditEngagement: number | null; // upvotes + comments across recent posts
  redditSentiment: number | null; // -1..1 crude lexicon score over titles

  // Telegram (public channel preview page)
  telegramMembers: number | null;
  telegramMembersPrev: number | null; // from the previous snapshot

  // X / Twitter (optional, requires TWITTER_BEARER_TOKEN)
  xMentions24h: number | null;

  missingSources: string[];
}

/** AI-assisted meme quality assessment (optional, requires ANTHROPIC_API_KEY). */
export interface MemeAssessment {
  originality: number; // 0–100
  humor: number; // 0–100 memorability / comedic appeal
  trendRelevance: number; // 0–100 tie-in to current internet culture
  brandAppeal: number; // 0–100 name/branding likely to attract attention
  reasoning: string;
}

export interface FactorReading {
  name: string;
  /** 0..1 quality (0.5 = neutral / unknown) */
  value: number;
  weight: number;
  detail: string;
}

export interface NarrativeReport {
  memeScore: number; // 0–100
  narrativeScore: number; // 0–100
  rugRiskScore: number; // 0–100, higher = riskier
  sentiment: number | null; // -1..1

  bullishFactors: string[];
  bearishFactors: string[];
  memeExplanation: string;
  narrativeExplanation: string;
  rugExplanation: string;

  narrativeFactors: FactorReading[];
  rugFactors: FactorReading[];
  signals: SocialSignals;
  memeAssessment: MemeAssessment | null;
}

/** Configurable weights for the narrative score components (sum need not be 1). */
export interface NarrativeWeights {
  socialPresence: number;
  attentionVelocity: number;
  mentionVelocity: number;
  engagement: number;
  communityGrowth: number;
  crossPlatform: number;
  sentiment: number;
}

export const DEFAULT_NARRATIVE_WEIGHTS: NarrativeWeights = {
  socialPresence: 10,
  attentionVelocity: 20,
  mentionVelocity: 20,
  engagement: 15,
  communityGrowth: 15,
  crossPlatform: 10,
  sentiment: 10,
};

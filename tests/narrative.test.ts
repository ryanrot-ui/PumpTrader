import { describe, expect, it } from "vitest";
import { computeMemeScore, computeNarrativeScore } from "../src/engine/narrative/aggregate";
import { evaluateNarrativeExit } from "../src/engine/narrative/exit";
import { DEFAULT_NARRATIVE_WEIGHTS, type SocialSignals } from "../src/engine/narrative/types";
import { parseRedditSearch, scoreTitleSentiment } from "../src/engine/narrative/providers/reddit";
import { parseTelegramMembers } from "../src/engine/narrative/providers/telegram";

const emptySignals = (over: Partial<SocialSignals> = {}): SocialSignals => ({
  hasTwitter: false,
  hasTelegram: false,
  hasWebsite: false,
  telegramHandle: null,
  boostsActive: null,
  description: null,
  txnAcceleration: null,
  volumeAcceleration: null,
  redditPosts24h: null,
  redditPostsPrior6d: null,
  redditEngagement: null,
  redditSentiment: null,
  telegramMembers: null,
  telegramMembersPrev: null,
  xMentions24h: null,
  missingSources: [],
  ...over,
});

describe("narrative score", () => {
  it("scores all-missing data near neutral, never bullish", () => {
    const { score } = computeNarrativeScore(emptySignals(), DEFAULT_NARRATIVE_WEIGHTS);
    expect(score).toBeGreaterThanOrEqual(30);
    expect(score).toBeLessThanOrEqual(55);
  });

  it("rewards strong multi-platform organic traction", () => {
    const strong = emptySignals({
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      txnAcceleration: 3.5,
      volumeAcceleration: 2.8,
      redditPosts24h: 20,
      redditPostsPrior6d: 6,
      redditEngagement: 900,
      redditSentiment: 0.6,
      telegramMembers: 4000,
      telegramMembersPrev: 3000,
      xMentions24h: 300,
      boostsActive: 0,
    });
    const weak = computeNarrativeScore(emptySignals(), DEFAULT_NARRATIVE_WEIGHTS);
    const result = computeNarrativeScore(strong, DEFAULT_NARRATIVE_WEIGHTS);
    expect(result.score).toBeGreaterThan(80);
    expect(result.score).toBeGreaterThan(weak.score);
    expect(result.explanation).toContain("Strongest");
  });

  it("caps the score when paid boosts are active", () => {
    const boosted = emptySignals({
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      txnAcceleration: 4,
      redditPosts24h: 30,
      redditPostsPrior6d: 3,
      redditEngagement: 2000,
      redditSentiment: 0.8,
      telegramMembers: 8000,
      telegramMembersPrev: 5000,
      xMentions24h: 500,
      boostsActive: 3,
    });
    const { score, explanation } = computeNarrativeScore(boosted, DEFAULT_NARRATIVE_WEIGHTS);
    expect(score).toBeLessThanOrEqual(65);
    expect(explanation).toContain("paid");
  });

  it("penalizes shrinking communities", () => {
    const shrinking = emptySignals({ telegramMembers: 800, telegramMembersPrev: 1200 });
    const growing = emptySignals({ telegramMembers: 1200, telegramMembersPrev: 800 });
    expect(
      computeNarrativeScore(shrinking, DEFAULT_NARRATIVE_WEIGHTS).score
    ).toBeLessThan(computeNarrativeScore(growing, DEFAULT_NARRATIVE_WEIGHTS).score);
  });
});

describe("meme score", () => {
  it("works without the AI assessment (spread signals only)", () => {
    const { score, explanation } = computeMemeScore(
      emptySignals({ redditPosts24h: 8, txnAcceleration: 2.5, telegramMembers: 1500, boostsActive: 0 }),
      null
    );
    expect(score).toBeGreaterThan(40);
    expect(explanation).toContain("AI assessment not configured");
  });

  it("blends AI quality with observed spread", () => {
    const ai = { originality: 90, humor: 85, trendRelevance: 95, brandAppeal: 80, reasoning: "tied to a live viral moment" };
    const noSpread = computeMemeScore(emptySignals({ boostsActive: 0 }), ai);
    const withSpread = computeMemeScore(
      emptySignals({ redditPosts24h: 12, txnAcceleration: 3, telegramMembers: 2500, boostsActive: 0 }),
      ai
    );
    expect(withSpread.score).toBeGreaterThan(noSpread.score);
    expect(withSpread.explanation).toContain("viral");
  });
});

describe("narrative exit", () => {
  it("no exit while narrative holds up", () => {
    expect(
      evaluateNarrativeExit({
        entryNarrativeScore: 70,
        currentNarrativeScore: 62,
        currentRugRiskScore: 40,
        sentiment: 0.1,
      }).exit
    ).toBe(false);
  });

  it("exits on narrative collapse vs entry", () => {
    const r = evaluateNarrativeExit({
      entryNarrativeScore: 80,
      currentNarrativeScore: 35,
      currentRugRiskScore: 40,
      sentiment: null,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toContain("at entry");
  });

  it("exits on rug risk spike regardless of narrative", () => {
    const r = evaluateNarrativeExit({
      entryNarrativeScore: null,
      currentNarrativeScore: 75,
      currentRugRiskScore: 85,
      sentiment: 0.5,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toContain("rug risk");
  });

  it("exits on strongly negative sentiment", () => {
    const r = evaluateNarrativeExit({
      entryNarrativeScore: 60,
      currentNarrativeScore: 55,
      currentRugRiskScore: 30,
      sentiment: -0.8,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toContain("sentiment");
  });
});

describe("reddit provider parsing", () => {
  const post = (hoursAgo: number, title: string, score = 5, comments = 2) => ({
    data: {
      title,
      score,
      num_comments: comments,
      created_utc: Date.now() / 1000 - hoursAgo * 3600,
    },
  });

  it("splits 24h posts from the prior-week baseline and sums engagement", () => {
    const r = parseRedditSearch([
      post(2, "This coin is a gem, LFG", 10, 5),
      post(20, "early on this one"),
      post(60, "old discussion"),
      post(100, "even older"),
    ]);
    expect(r.posts24h).toBe(2);
    expect(r.postsPrior6d).toBe(2);
    expect(r.engagement).toBe(22);
    expect(r.sentiment).toBeGreaterThan(0);
  });

  it("sentiment: negative titles dominate", () => {
    expect(scoreTitleSentiment(["obvious rug, avoid", "total scam warning"])).toBeLessThan(0);
    expect(scoreTitleSentiment(["what is this token?"])).toBe(0);
    expect(scoreTitleSentiment([])).toBeNull();
  });
});

describe("telegram provider parsing", () => {
  it("parses member counts in common formats", () => {
    expect(parseTelegramMembers('<div class="tgme_page_extra">12 345 members</div>')).toBe(12345);
    expect(parseTelegramMembers("1,234 subscribers")).toBe(1234);
    expect(parseTelegramMembers("987 members, 45 online")).toBe(987);
  });
  it("returns null when no count is present", () => {
    expect(parseTelegramMembers("<html>channel not found</html>")).toBeNull();
  });
});

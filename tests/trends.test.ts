import { describe, expect, it } from "vitest";
import {
  extractTerms,
  matchTokenToNarratives,
  normalizeTerm,
  trendScoreAdjustment,
  type NarrativeLite,
} from "@/engine/narrative/trends";

const narrative = (over: Partial<NarrativeLite> & { term: string }): NarrativeLite => ({
  display: over.term,
  mentions: 5,
  growthPct: 50,
  peaked: false,
  influencers: [],
  sources: ["reddit"],
  ...over,
});

describe("term extraction", () => {
  it("extracts hashtags, cashtags, proper nouns and shouted phrases", () => {
    const terms = extractTerms("Just bought $PEANUT!! #Peanut squirrel saga continues. DOGE TO MARS soon says Elon");
    expect(terms).toContain("peanut");
    expect(terms).toContain("doge mars"); // stopword "to" removed
    expect(terms).not.toContain("the");
  });

  it("normalizes case and symbols", () => {
    expect(normalizeTerm("$PeaNut!!")).toBe("peanut");
    expect(normalizeTerm("  Doge   Mars ")).toBe("doge mars");
  });
});

describe("token ↔ narrative matching (semantic, not exact keyword)", () => {
  const active = [
    narrative({ term: "peanut", influencers: ["elonmusk"], sources: ["x", "reddit"] }),
    narrative({ term: "doge mars" }),
    narrative({ term: "america" }),
  ];

  it("matches exact symbol at ~97%", () => {
    const m = matchTokenToNarratives("Peanut the Squirrel", "PEANUT", active)!;
    expect(m.narrative).toBe("peanut");
    expect(m.matchPct).toBeGreaterThanOrEqual(95);
    expect(m.influencers).toContain("elonmusk");
  });

  it("matches concatenated multi-word narratives (DOGEMARS ← 'doge to mars')", () => {
    const m = matchTokenToNarratives("DogeMars", "DOGEMARS", active)!;
    expect(m.narrative).toBe("doge mars");
    expect(m.matchPct).toBeGreaterThanOrEqual(90);
  });

  it("matches close variants via edit distance", () => {
    const m = matchTokenToNarratives("Amerika", "AMERIKA", active)!;
    expect(m.narrative).toBe("america");
    expect(m.matchPct).toBeGreaterThanOrEqual(70);
  });

  it("returns null when nothing is close", () => {
    expect(matchTokenToNarratives("Quantum Frog", "QFROG", active)).toBeNull();
    expect(matchTokenToNarratives(null, null, active)).toBeNull();
  });
});

describe("trend score adjustment (bounded, peak-aware)", () => {
  it("rewards a growing cross-platform match, bounded", () => {
    const { delta, detail } = trendScoreAdjustment({
      narrative: "peanut",
      matchPct: 97,
      trendGrowthPct: 150,
      peaked: false,
      influencers: ["elonmusk", "blknoiz06"],
      sources: ["x", "reddit"],
    });
    expect(delta).toBeGreaterThanOrEqual(12);
    expect(delta).toBeLessThanOrEqual(17); // bounded — never dominates the score
    expect(detail).toMatch(/growing/);
    expect(detail).toMatch(/cross-platform/);
  });

  it("penalizes matches whose trend already peaked", () => {
    const { delta, detail } = trendScoreAdjustment({
      narrative: "peanut",
      matchPct: 97,
      trendGrowthPct: -40,
      peaked: true,
      influencers: [],
      sources: ["reddit"],
    });
    expect(delta).toBeLessThan(0);
    expect(detail).toMatch(/peaked/);
  });

  it("is zero with no match", () => {
    expect(trendScoreAdjustment(null).delta).toBe(0);
  });
});

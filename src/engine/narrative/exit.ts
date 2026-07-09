/**
 * Post-entry narrative deterioration detection. Pure so it is unit-testable;
 * the engine decides (via settings.narrativeExitMode) whether a signal is
 * logged as an alert or executed as a market exit.
 */

export interface NarrativeExitInput {
  entryNarrativeScore: number | null; // from Position.entrySignals
  currentNarrativeScore: number;
  currentRugRiskScore: number;
  sentiment: number | null; // -1..1
}

export interface NarrativeExitSignal {
  exit: boolean;
  reason: string;
}

const NARRATIVE_FLOOR = 30; // absolute deterioration floor
const NARRATIVE_COLLAPSE_RATIO = 0.5; // vs the score at entry
const RUG_RISK_CEILING = 80;
const SENTIMENT_FLOOR = -0.6;

export function evaluateNarrativeExit(i: NarrativeExitInput): NarrativeExitSignal {
  if (i.currentRugRiskScore >= RUG_RISK_CEILING) {
    return {
      exit: true,
      reason: `rug risk rose to ${i.currentRugRiskScore}/100 (ceiling ${RUG_RISK_CEILING})`,
    };
  }
  if (i.currentNarrativeScore < NARRATIVE_FLOOR) {
    return {
      exit: true,
      reason: `narrative collapsed to ${i.currentNarrativeScore}/100 (floor ${NARRATIVE_FLOOR})`,
    };
  }
  if (
    i.entryNarrativeScore !== null &&
    i.entryNarrativeScore > 0 &&
    i.currentNarrativeScore < i.entryNarrativeScore * NARRATIVE_COLLAPSE_RATIO
  ) {
    return {
      exit: true,
      reason: `narrative fell to ${i.currentNarrativeScore} from ${i.entryNarrativeScore} at entry (>${(1 - NARRATIVE_COLLAPSE_RATIO) * 100}% drop)`,
    };
  }
  if (i.sentiment !== null && i.sentiment <= SENTIMENT_FLOOR) {
    return {
      exit: true,
      reason: `sentiment turned strongly negative (${i.sentiment.toFixed(2)})`,
    };
  }
  return { exit: false, reason: "" };
}

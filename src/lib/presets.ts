/**
 * Named strategy presets. Shared by the settings UI (one-click apply), the
 * diagnostics endpoint (active-strategy detection), and the backtester
 * (strategy comparison). Applying a preset saves it through /api/settings,
 * which the engine hot-reloads within seconds — no restart.
 *
 * Presets only touch STRATEGY parameters (entries, exits, timing). Money and
 * risk limits (buy size, exposure caps, daily loss limit) are deliberately
 * never part of a preset — switching styles must not silently change how
 * much capital is at risk.
 */

export interface StrategyPreset {
  name: PresetName;
  label: string;
  description: string;
  values: Record<string, number | boolean | null>;
}

export type PresetName =
  | "scalper"
  | "momentum"
  | "balanced"
  | "conservative"
  | "aggressive"
  | "experimental";

export const PRESETS: StrategyPreset[] = [
  {
    name: "scalper",
    label: "Scalper",
    description: "Very fast in/out: +8% target, -4% stop, cut anything weak in 2.5 min. Banks the target immediately (winners never run).",
    values: {
      confidenceThreshold: 72,
      takeProfitPct: 8,
      stopLossPct: 4,
      trailingStopPct: 3,
      maxHoldMinutes: 6,
      sellPortionPct: 100,
      exitMinBuySellRatio: 0.9,
      exitVolumeFadePct: 55,
      exitLiquidityDropPct: 25,
      maxEntryPriceChange5mPct: 25,
      maxEntryPriceChange1hPct: 100,
      requireRisingMomentum: false,
      letWinnersRun: false,
      adaptiveTrailing: true,
      cutWeakAfterMinutes: 2.5,
      scoringWeights: null,
    },
  },
  {
    name: "momentum",
    label: "Momentum",
    description: "The classic momentum scalp: ride building moves, +12% target deferred while buyers are strong, tight momentum exits.",
    values: {
      confidenceThreshold: 70,
      takeProfitPct: 12,
      stopLossPct: 6,
      trailingStopPct: 5,
      maxHoldMinutes: 10,
      sellPortionPct: 100,
      exitMinBuySellRatio: 0.75,
      exitVolumeFadePct: 65,
      exitLiquidityDropPct: 25,
      maxEntryPriceChange5mPct: 35,
      maxEntryPriceChange1hPct: 175,
      requireRisingMomentum: false,
      letWinnersRun: true,
      adaptiveTrailing: true,
      cutWeakAfterMinutes: 4,
      scoringWeights: null,
    },
  },
  {
    name: "balanced",
    label: "Balanced",
    description: "Middle ground: +20% target, wider stops, 20-minute holds, winners run behind an adaptive trail.",
    values: {
      confidenceThreshold: 78,
      takeProfitPct: 20,
      stopLossPct: 8,
      trailingStopPct: 8,
      maxHoldMinutes: 20,
      sellPortionPct: 100,
      exitMinBuySellRatio: 0.6,
      exitVolumeFadePct: 70,
      exitLiquidityDropPct: 25,
      maxEntryPriceChange5mPct: 50,
      maxEntryPriceChange1hPct: 250,
      requireRisingMomentum: false,
      letWinnersRun: true,
      adaptiveTrailing: true,
      cutWeakAfterMinutes: 6,
      scoringWeights: null,
    },
  },
  {
    name: "conservative",
    label: "Conservative",
    description: "Only the highest-conviction setups (score ≥ 85), strict anti-chase limits, tight -5% stop, quick profit-taking.",
    values: {
      confidenceThreshold: 85,
      takeProfitPct: 15,
      stopLossPct: 5,
      trailingStopPct: 5,
      maxHoldMinutes: 15,
      sellPortionPct: 100,
      exitMinBuySellRatio: 0.8,
      exitVolumeFadePct: 60,
      exitLiquidityDropPct: 20,
      maxEntryPriceChange5mPct: 20,
      maxEntryPriceChange1hPct: 100,
      requireRisingMomentum: false,
      letWinnersRun: false,
      adaptiveTrailing: true,
      cutWeakAfterMinutes: 4,
      scoringWeights: null,
    },
  },
  {
    name: "aggressive",
    label: "Aggressive",
    description: "More trades, more room: score ≥ 60, +25% target, -10% stop, 30-minute holds, loose chase limits. Highest variance.",
    values: {
      confidenceThreshold: 60,
      takeProfitPct: 25,
      stopLossPct: 10,
      trailingStopPct: 10,
      maxHoldMinutes: 30,
      sellPortionPct: 100,
      exitMinBuySellRatio: 0.5,
      exitVolumeFadePct: 75,
      exitLiquidityDropPct: 30,
      maxEntryPriceChange5mPct: 60,
      maxEntryPriceChange1hPct: 400,
      requireRisingMomentum: false,
      letWinnersRun: true,
      adaptiveTrailing: true,
      cutWeakAfterMinutes: 6,
      scoringWeights: null,
    },
  },
  {
    name: "experimental",
    label: "Experimental",
    description: "Acceleration-only entries: requires momentum to be actively building and price barely moved yet (+20%/5m max). Few, early entries.",
    values: {
      confidenceThreshold: 65,
      takeProfitPct: 15,
      stopLossPct: 5,
      trailingStopPct: 4,
      maxHoldMinutes: 12,
      sellPortionPct: 100,
      exitMinBuySellRatio: 0.85,
      exitVolumeFadePct: 60,
      exitLiquidityDropPct: 25,
      maxEntryPriceChange5mPct: 20,
      maxEntryPriceChange1hPct: 80,
      requireRisingMomentum: true,
      letWinnersRun: true,
      adaptiveTrailing: true,
      cutWeakAfterMinutes: 3,
      scoringWeights: null,
    },
  },
];

export function getPreset(name: string): StrategyPreset | undefined {
  return PRESETS.find((p) => p.name === name);
}

/** Which named preset (if any) the given settings match. */
export function detectPreset(
  s: Record<string, unknown> | null | undefined
): PresetName | "custom" {
  if (!s) return "custom";
  for (const preset of PRESETS) {
    const matches = Object.entries(preset.values).every(
      ([k, v]) => JSON.stringify(s[k] ?? null) === JSON.stringify(v)
    );
    if (matches) return preset.name;
  }
  return "custom";
}

/** Backward compatibility: the original momentum-scalping preset values. */
export const SCALPING_PRESET = PRESETS.find((p) => p.name === "momentum")!.values;

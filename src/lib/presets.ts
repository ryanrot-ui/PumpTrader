/**
 * Named strategy presets. Shared by the settings UI (apply button), the
 * diagnostics endpoint (active-strategy detection), and anything else that
 * needs to answer "which strategy is this configuration?".
 */

export const SCALPING_PRESET = {
  confidenceThreshold: 70,
  takeProfitPct: 12,
  stopLossPct: 6,
  trailingStopPct: 5,
  maxHoldMinutes: 10,
  sellPortionPct: 100,
  exitMinBuySellRatio: 0.75,
  exitVolumeFadePct: 65,
  exitLiquidityDropPct: 25,
  scoringWeights: null as null,
} as const;

export type PresetName = "momentum-scalping" | "custom";

/** Which named preset (if any) the given settings match. */
export function detectPreset(s: Record<string, unknown> | null | undefined): PresetName {
  if (!s) return "custom";
  const matches = Object.entries(SCALPING_PRESET).every(
    ([k, v]) => JSON.stringify(s[k] ?? null) === JSON.stringify(v)
  );
  return matches ? "momentum-scalping" : "custom";
}

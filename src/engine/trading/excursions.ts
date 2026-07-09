/**
 * Per-position excursion tracking: the running peak price (drives the
 * trailing stop), the best unrealized gain, and the deepest peak-to-trough
 * drawdown seen while the position is open. Pure function so it is trivially
 * unit-tested; the engine persists the result on each monitor tick.
 */

export interface ExcursionState {
  peakPriceUsd: number | null;
  maxUnrealizedPnlPct: number | null;
  maxDrawdownPct: number | null;
}

export function trackExcursions(
  entryPriceUsd: number,
  prev: ExcursionState,
  currentPriceUsd: number
): { changed: boolean; next: ExcursionState } {
  const peak = Math.max(prev.peakPriceUsd ?? currentPriceUsd, currentPriceUsd);

  const unrealizedPct = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
  const maxUnrealized = Math.max(prev.maxUnrealizedPnlPct ?? unrealizedPct, unrealizedPct);

  // Drawdown = drop from the highest price seen so far, as a positive %.
  const drawdownPct = peak > 0 ? ((peak - currentPriceUsd) / peak) * 100 : 0;
  const maxDrawdown = Math.max(prev.maxDrawdownPct ?? drawdownPct, drawdownPct);

  const next: ExcursionState = {
    peakPriceUsd: peak,
    maxUnrealizedPnlPct: maxUnrealized,
    maxDrawdownPct: maxDrawdown,
  };
  const changed =
    next.peakPriceUsd !== prev.peakPriceUsd ||
    next.maxUnrealizedPnlPct !== prev.maxUnrealizedPnlPct ||
    next.maxDrawdownPct !== prev.maxDrawdownPct;
  return { changed, next };
}

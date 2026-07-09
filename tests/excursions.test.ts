import { describe, expect, it } from "vitest";
import { trackExcursions, type ExcursionState } from "../src/engine/trading/excursions";

const empty: ExcursionState = {
  peakPriceUsd: null,
  maxUnrealizedPnlPct: null,
  maxDrawdownPct: null,
};

function run(entry: number, prices: number[]): ExcursionState {
  let state = empty;
  for (const price of prices) {
    state = trackExcursions(entry, state, price).next;
  }
  return state;
}

describe("trackExcursions", () => {
  it("initialises from the first observed price", () => {
    const { next, changed } = trackExcursions(1, empty, 1.2);
    expect(changed).toBe(true);
    expect(next.peakPriceUsd).toBe(1.2);
    expect(next.maxUnrealizedPnlPct).toBeCloseTo(20);
    expect(next.maxDrawdownPct).toBe(0);
  });

  it("tracks the running peak and best unrealized gain", () => {
    const state = run(1, [1.1, 1.5, 1.3, 2.0, 1.8]);
    expect(state.peakPriceUsd).toBe(2.0);
    expect(state.maxUnrealizedPnlPct).toBeCloseTo(100);
  });

  it("tracks the deepest drawdown from the peak", () => {
    // peak 2.0, trough afterwards 1.0 → 50% drawdown
    const state = run(1, [1.5, 2.0, 1.4, 1.0, 1.6]);
    expect(state.maxDrawdownPct).toBeCloseTo(50);
  });

  it("records negative max unrealized PnL when the position only fell", () => {
    const state = run(1, [0.9, 0.8]);
    expect(state.maxUnrealizedPnlPct).toBeCloseTo(-10); // best it ever got
    expect(state.maxDrawdownPct).toBeCloseTo((0.9 - 0.8) / 0.9 * 100);
  });

  it("reports changed=false when nothing moved", () => {
    const first = trackExcursions(1, empty, 1.2).next;
    const second = trackExcursions(1, first, 1.2);
    expect(second.changed).toBe(false);
  });
});

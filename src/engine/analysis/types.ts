/**
 * Every measurable signal about a token. Any field may be `null` when its
 * data source is unavailable — the scoring engine treats missing data as
 * neutral (never as a green flag) and records which inputs were missing.
 */
export interface TokenMetrics {
  mint: string;
  symbol: string | null;
  name: string | null;
  poolAddress: string | null;
  migratedAt: Date;

  // Market
  priceUsd: number | null;
  liquiditySol: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volumeGrowthPct: number | null; // 5m volume vs previous 5m window
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;

  // Activity
  txPerMinute: number | null;
  buys5m: number | null;
  sells5m: number | null;
  buySellRatio: number | null; // buys / max(sells, 1)

  // Holders
  holderCount: number | null;
  holderGrowth5m: number | null; // new holders in last window
  topHolderPct: number | null; // largest non-pool holder, % of supply
  top10HolderPct: number | null; // top 10 non-pool holders, % of supply
  devWalletPct: number | null; // deployer's current holding, % of supply
  freshWalletPct: number | null; // % of recent buyers with near-zero history
  sniperWalletCount: number | null; // wallets that bought in first blocks
  bundledWalletCount: number | null; // wallets funded from one source

  // Stability / momentum
  liquidityChangePct: number | null; // liquidity now vs at detection
  estSlippagePctFor1Sol: number | null;
  volatility5m: number | null; // stdev of 1m returns, %
  momentum: number | null; // short EMA slope of price, %/min
  momentumAcceleration: number | null; // change of momentum between windows

  // Safety
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  lpBurnedOrLockedPct: number | null;
  isHoneypotSuspected: boolean | null; // sells consistently failing
  devSoldPct: number | null; // % of dev's initial allocation sold
  washTradingSuspected: boolean | null; // self-trades / circular flows
  artificialVolumeSuspected: boolean | null; // volume >> unique wallets
  devReputationScore: number | null; // 0..1 from prior launches, if known

  // Bookkeeping
  ageSinceMigrationSec: number;
  missingSources: string[]; // which collectors failed / were skipped
}

export interface MetricScore {
  metric: string;
  /** 0..1 quality for this metric (0.5 = neutral / unknown) */
  value: number;
  weight: number;
  /** weighted contribution actually applied */
  contribution: number;
  detail: string;
}

export interface FlagResult {
  id: string;
  label: string;
  detail: string;
}

export interface ScoreResult {
  total: number; // 0..100
  metrics: MetricScore[];
  greenFlags: FlagResult[];
  redFlags: FlagResult[];
  criticalFlags: FlagResult[]; // subset of redFlags that block buying outright
  missingSources: string[];
  explanation: string; // one-paragraph human-readable summary
}

import type { TokenMetrics } from "../analysis/types";
import type { FactorReading } from "./types";

/**
 * Rug-pull risk estimate (0–100, higher = riskier) composed from measurable
 * on-chain and market indicators. This is an evidence-based ESTIMATE — it can
 * neither prove nor rule out a rug. Unknown inputs contribute a mildly
 * elevated risk (0.6) because opacity itself is a risk factor here, and each
 * factor's contribution is recorded for the explanation.
 */

interface RugFactorSpec {
  name: string;
  weight: number;
  /** returns risk 0..1 (1 = worst) and a human-readable detail, or null when unknown */
  read: (m: TokenMetrics) => { risk: number; detail: string } | null;
}

const scale = (value: number, safe: number, danger: number): number => {
  if (danger === safe) return 0.5;
  const t = (value - safe) / (danger - safe);
  return Math.max(0, Math.min(1, t));
};

const FACTORS: RugFactorSpec[] = [
  {
    name: "mint authority",
    weight: 15,
    read: (m) =>
      m.mintAuthorityRevoked === null
        ? null
        : m.mintAuthorityRevoked
          ? { risk: 0, detail: "mint authority revoked" }
          : { risk: 1, detail: "mint authority ACTIVE — supply can be inflated" },
  },
  {
    name: "freeze authority",
    weight: 10,
    read: (m) =>
      m.freezeAuthorityRevoked === null
        ? null
        : m.freezeAuthorityRevoked
          ? { risk: 0, detail: "freeze authority revoked" }
          : { risk: 1, detail: "freeze authority ACTIVE — transfers can be frozen" },
  },
  {
    name: "LP security",
    weight: 12,
    read: (m) =>
      m.lpBurnedOrLockedPct === null
        ? null
        : {
            risk: scale(m.lpBurnedOrLockedPct, 95, 0),
            detail: `${m.lpBurnedOrLockedPct.toFixed(0)}% of LP burned/locked`,
          },
  },
  {
    name: "liquidity level",
    weight: 10,
    read: (m) =>
      m.liquidityUsd === null
        ? null
        : {
            risk: scale(m.liquidityUsd, 100_000, 5_000),
            detail: `$${Math.round(m.liquidityUsd).toLocaleString()} pool liquidity`,
          },
  },
  {
    name: "liquidity trend",
    weight: 10,
    read: (m) =>
      m.liquidityChangePct === null
        ? null
        : {
            risk: scale(m.liquidityChangePct, 0, -40),
            detail: `liquidity ${m.liquidityChangePct >= 0 ? "+" : ""}${m.liquidityChangePct.toFixed(0)}% since detection`,
          },
  },
  {
    name: "holder concentration",
    weight: 12,
    read: (m) => {
      if (m.top10HolderPct !== null)
        return {
          risk: scale(m.top10HolderPct, 20, 70),
          detail: `top 10 holders own ${m.top10HolderPct.toFixed(0)}% of supply`,
        };
      if (m.topHolderPct !== null)
        return {
          risk: scale(m.topHolderPct, 5, 30),
          detail: `largest holder owns ${m.topHolderPct.toFixed(0)}%`,
        };
      return null;
    },
  },
  {
    name: "developer behavior",
    weight: 10,
    read: (m) => {
      if (m.devSoldPct !== null && m.devSoldPct > 30)
        return { risk: 1, detail: `developer sold ${m.devSoldPct.toFixed(0)}% of allocation` };
      if (m.devWalletPct !== null)
        return {
          risk: scale(m.devWalletPct, 2, 25),
          detail: `developer holds ${m.devWalletPct.toFixed(1)}%`,
        };
      return null;
    },
  },
  {
    name: "suspicious wallets",
    weight: 8,
    read: (m) => {
      if (m.freshWalletPct === null && m.bundledWalletCount === null) return null;
      const fresh = m.freshWalletPct !== null ? scale(m.freshWalletPct, 20, 80) : 0.5;
      const bundled = m.bundledWalletCount !== null ? scale(m.bundledWalletCount, 2, 20) : 0.5;
      return {
        risk: Math.max(fresh, bundled),
        detail: `${m.freshWalletPct?.toFixed(0) ?? "?"}% fresh-wallet buyers, ${m.bundledWalletCount ?? "?"} bundled wallets`,
      };
    },
  },
  {
    name: "trading anomalies",
    weight: 8,
    read: (m) => {
      if (m.isHoneypotSuspected) return { risk: 1, detail: "sells failing — honeypot suspected" };
      if (m.washTradingSuspected || m.artificialVolumeSuspected)
        return { risk: 0.85, detail: "wash-trading / artificial volume patterns detected" };
      if (m.washTradingSuspected === null && m.artificialVolumeSuspected === null) return null;
      return { risk: 0.1, detail: "no trading anomalies detected" };
    },
  },
  {
    name: "sell pressure",
    weight: 5,
    read: (m) =>
      m.buySellRatio === null
        ? null
        : {
            risk: scale(m.buySellRatio, 1.5, 0.4),
            detail: `buy/sell ratio ${m.buySellRatio.toFixed(2)}`,
          },
  },
];

const UNKNOWN_RISK = 0.6; // opacity is itself a (mild) risk signal

export function assessRugRisk(m: TokenMetrics): {
  score: number;
  factors: FactorReading[];
  explanation: string;
} {
  const factors: FactorReading[] = FACTORS.map((spec) => {
    const reading = spec.read(m);
    return {
      name: spec.name,
      value: reading?.risk ?? UNKNOWN_RISK,
      weight: spec.weight,
      detail: reading?.detail ?? "no data — treated as elevated risk",
    };
  });

  const totalWeight = factors.reduce((a, f) => a + f.weight, 0);
  const score = Math.round(
    (factors.reduce((a, f) => a + f.value * f.weight, 0) / totalWeight) * 100
  );

  const worst = [...factors].sort((a, b) => b.value * b.weight - a.value * a.weight)[0];
  const best = [...factors].sort((a, b) => a.value * a.weight - b.value * b.weight)[0];
  const explanation =
    `Rug risk ${score}/100 (estimate, not a guarantee). ` +
    `Biggest concern: ${worst.name} (${worst.detail}). ` +
    `Strongest safety signal: ${best.name} (${best.detail}).`;

  return { score, factors, explanation };
}

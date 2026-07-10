"use client";

import { useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { FlagPills, ScoreBadge, shortMint, timeAgo } from "@/components/ui";
import { HealthIndicators, type Health } from "@/components/HealthIndicators";
import { PriceChart, type PricePoint, type TradeMarker } from "@/components/charts/PriceChart";

interface MetricRow {
  metric: string;
  value: number;
  weight: number;
  contribution: number;
  detail: string;
}

interface TokenRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  telegramUrl: string | null;
  detectedAt: string;
  migratedAt: string;
  verdict: string | null;
  rejectionReasons: string[];
  decisionTrace: Array<{
    rule: string;
    layer: "safety" | "opportunity" | "risk";
    hard: boolean;
    passed: boolean;
    detail: string;
  }> | null;
  confidence: number | null;
  score: number | null;
  narrativeScore: number | null;
  memeScore: number | null;
  rugRiskScore: number | null;
  greenFlags: string[];
  redFlags: string[];
  critical: boolean;
  breakdown: MetricRow[] | null;
  snapshot: {
    at?: string;
    priceUsd: number | null;
    liquiditySol: number | null;
    marketCapUsd: number | null;
    holderCount: number | null;
  } | null;
}

/** Engine constant (src/engine): how long a detected token stays watched. */
const WATCH_WINDOW_MS = 45 * 60_000;

interface TokenDetail {
  snapshots: Array<{ at: string; priceUsd: number | null; volume5mUsd: number | null }>;
  trades: Array<{ side: string; createdAt: string; reason: string }>;
}

export default function ScannerPage() {
  const { data: tokens } = usePoll<TokenRow[]>("/api/tokens?limit=100", 8000);
  const { data: health } = usePoll<Health>("/api/health", 10_000);
  const { data: settings } = usePoll<{ confidenceThreshold?: number }>("/api/settings", 60_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  // Explain an empty list with the actual reason rather than a generic message.
  const emptyReason = (() => {
    if (!health) return "Loading scanner status…";
    if (!health.engineAlive)
      return "The engine worker isn’t running — no tokens can be detected. On Render, start the pumptrader-engine worker with the same DATABASE_URL as the web service.";
    if (health.scannerError)
      return `Scanner can’t reach Solana RPC: ${health.scannerError}. Detection is paused until the RPC recovers.`;
    if (health.usingPublicRpc)
      return "Scanner is running on the public Solana RPC, which rejects the realtime websocket and rate-limits polling — detection is slow or empty. Set SOLANA_RPC_URL (and SOLANA_WS_URL) to a dedicated provider for reliable scanning.";
    return "Scanner is active and watching for Pump.fun graduations (PumpSwap pool creations). New coins appear here as they migrate — none in the current window yet.";
  })();

  const filtered = (tokens ?? []).filter((t) => {
    if (filter === "candidates") return t.verdict === "BUY_CANDIDATE" || t.verdict === "BOUGHT";
    if (filter === "rejected") return t.verdict === "REJECTED";
    if (filter === "high") return (t.score ?? 0) >= 70;
    return true;
  });

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-xl font-semibold">Token scanner</h1>
        <div className="flex gap-1.5">
          {(["all", "high", "candidates", "rejected"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`btn text-xs ${filter === f ? "btn-primary" : "btn-ghost"}`}
            >
              {f === "all" ? "All" : f === "high" ? "Score ≥ 70" : f === "candidates" ? "Bought" : "Rejected"}
            </button>
          ))}
        </div>
      </div>

      <HealthIndicators health={health} />

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-surface-border">
              <th className="pb-2 pr-4">Token</th>
              <th className="pb-2 pr-4">Score</th>
              <th className="pb-2 pr-4">Price</th>
              <th className="pb-2 pr-4">Liq (SOL)</th>
              <th className="pb-2 pr-4">MCap</th>
              <th className="pb-2 pr-4">Holders</th>
              <th className="pb-2 pr-4">Verdict</th>
              <th className="pb-2">Age</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <TokenTableRow
                key={t.mint}
                t={t}
                onClick={() => setSelected(selected === t.mint ? null : t.mint)}
              />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 px-4 text-center text-slate-500 text-xs max-w-0">
                  {tokens && tokens.length > 0 ? "No tokens match this filter." : emptyReason}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <TokenDrawer
          token={filtered.find((t) => t.mint === selected) ?? null}
          threshold={settings?.confidenceThreshold ?? null}
        />
      )}
    </AppShell>
  );
}

// ── Rich token row ───────────────────────────────────────────────────────────

/** Flashes its background when `value` changes between polls (live updates). */
function Flash({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const prev = useRef<string | null>(null);
  const changed = prev.current !== null && prev.current !== value;
  prev.current = value;
  return (
    <span key={changed ? `${value}-${Date.now()}` : value} className={`${className ?? ""} ${changed ? "animate-flash" : ""}`}>
      {children}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title="Copy mint address"
      className="text-slate-600 hover:text-slate-300 text-xs px-1"
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

function ExtLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-[10px] text-slate-600 hover:text-accent"
    >
      {label}
    </a>
  );
}

function TokenTableRow({ t, onClick }: { t: TokenRow; onClick: () => void }) {
  const price = t.snapshot?.priceUsd ?? null;
  const verdictTitle =
    t.verdict === "REJECTED" && t.rejectionReasons.length > 0
      ? `Rejected: ${t.rejectionReasons.join("; ")}`
      : t.verdict === "BOUGHT"
        ? "The engine opened a position on this token."
        : t.verdict == null
          ? "Still being evaluated — data may not be indexed yet."
          : undefined;
  return (
    <tr
      onClick={onClick}
      className="border-b border-surface-border/50 hover:bg-surface-overlay/50 cursor-pointer"
    >
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2 min-w-[180px]">
          {t.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={t.imageUrl}
              alt=""
              className="w-7 h-7 rounded-full shrink-0 bg-surface-overlay object-cover"
              loading="lazy"
              onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
            />
          ) : (
            <div className="w-7 h-7 rounded-full shrink-0 bg-surface-overlay flex items-center justify-center text-[10px] text-slate-500">
              {(t.symbol ?? t.mint).slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-slate-200 truncate max-w-[130px]" title={t.name ?? undefined}>
                {t.symbol ?? shortMint(t.mint)}
              </span>
              {t.name && <span className="text-slate-600 text-xs truncate max-w-[110px]">{t.name}</span>}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-600 font-mono">
              {shortMint(t.mint)}
              <CopyButton text={t.mint} />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClick();
                }}
                title="Full analysis: score math, every rule, decision reasoning"
                className="text-accent hover:underline"
              >
                Analysis
              </button>
              <ExtLink href={`https://pump.fun/coin/${t.mint}`} label="Pump" />
              <ExtLink href={`https://dexscreener.com/solana/${t.mint}`} label="DexScr" />
              <ExtLink href={`https://gmgn.ai/sol/token/${t.mint}`} label="GMGN" />
              <ExtLink href={`https://solscan.io/token/${t.mint}`} label="Solscan" />
              <ExtLink href={t.twitterUrl ?? `https://x.com/search?q=${t.mint}`} label="X" />
              {t.telegramUrl && <ExtLink href={t.telegramUrl} label="TG" />}
              {t.websiteUrl && <ExtLink href={t.websiteUrl} label="Web" />}
            </div>
          </div>
        </div>
      </td>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-1.5">
          <span title="Technical score (0–100): liquidity, volume, holders, distribution, momentum, safety — click the row for the full breakdown.">
            <ScoreBadge score={t.score} critical={t.critical} />
          </span>
          {t.narrativeScore != null && (
            <span title={`Narrative score ${t.narrativeScore}/100 — social presence & attention`} className="text-[10px] text-slate-500">
              N{t.narrativeScore}
            </span>
          )}
          {t.rugRiskScore != null && (
            <span
              title={`Rug-risk estimate ${t.rugRiskScore}/100 — higher is riskier`}
              className={`text-[10px] ${t.rugRiskScore >= 60 ? "text-loss" : "text-slate-500"}`}
            >
              R{t.rugRiskScore}
            </span>
          )}
        </div>
      </td>
      <td className="py-2 pr-4 font-mono text-slate-400">
        <Flash value={String(price ?? "—")}>{price ? `$${price.toPrecision(3)}` : "—"}</Flash>
      </td>
      <td className="py-2 pr-4 font-mono text-slate-400">
        <Flash value={String(t.snapshot?.liquiditySol?.toFixed(0) ?? "—")}>
          {t.snapshot?.liquiditySol?.toFixed(0) ?? "—"}
        </Flash>
      </td>
      <td className="py-2 pr-4 font-mono text-slate-400">
        <Flash value={String(t.snapshot?.marketCapUsd ?? "—")}>
          {t.snapshot?.marketCapUsd ? `$${Math.round(t.snapshot.marketCapUsd / 1000)}k` : "—"}
        </Flash>
      </td>
      <td
        className="py-2 pr-4 font-mono text-slate-400"
        title={t.snapshot?.holderCount == null ? "Holder metrics need HELIUS_API_KEY on the engine service" : undefined}
      >
        <Flash value={String(t.snapshot?.holderCount ?? "—")}>{t.snapshot?.holderCount ?? "—"}</Flash>
      </td>
      <td className="py-2 pr-4" title={verdictTitle}>
        <div>
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              t.verdict === "BOUGHT"
                ? "bg-profit/20 text-profit"
                : t.verdict === "REJECTED"
                  ? "bg-surface-overlay text-slate-500"
                  : "bg-warn/10 text-warn"
            }`}
          >
            {t.verdict ?? "EVALUATING"}
          </span>
          {t.verdict === "REJECTED" && t.rejectionReasons[0] && (
            <div className="text-[10px] text-slate-600 mt-0.5 max-w-[160px] truncate" title={t.rejectionReasons.join("; ")}>
              {t.rejectionReasons[0]}
              {t.rejectionReasons.length > 1 ? ` +${t.rejectionReasons.length - 1}` : ""}
            </div>
          )}
        </div>
      </td>
      <td className="py-2 text-slate-500 text-xs">{timeAgo(t.migratedAt)}</td>
    </tr>
  );
}

/**
 * The decision, made auditable: score vs threshold, suggested action with the
 * reasoning, whether the token is still monitored, when it was last
 * evaluated, and which inputs were missing (scored neutral).
 */
function DecisionPanel({ token, threshold }: { token: TokenRow; threshold: number | null }) {
  const score = token.score;
  const inWindow = Date.now() - new Date(token.migratedAt).getTime() < WATCH_WINDOW_MS;
  const monitored =
    token.verdict === "BOUGHT" || (inWindow && token.verdict !== "IGNORED");
  const neutral = (token.breakdown ?? []).filter((m) => m.value === 0.5).map((m) => m.metric);

  const action: { label: string; cls: string; why: string } =
    token.verdict === "BOUGHT"
      ? { label: "BOUGHT", cls: "bg-profit/20 text-profit", why: "Passed every rule — the engine opened a position." }
      : token.verdict === "BUY_CANDIDATE"
        ? { label: "BUY CANDIDATE", cls: "bg-profit/20 text-profit", why: "Passed every rule; awaiting execution/risk checks." }
        : token.verdict === "WATCH"
          ? { label: "WATCH", cls: "bg-warn/10 text-warn", why: "All safety gates passed — the score just hasn't cleared your acceptance threshold. Re-evaluated continuously while the window is open." }
          : token.verdict == null
            ? { label: "WATCH", cls: "bg-warn/10 text-warn", why: "Still inside the evaluation window — data may not be fully indexed yet." }
            : token.verdict === "IGNORED"
              ? { label: "EXPIRED", cls: "bg-surface-overlay text-slate-500", why: "The 45-minute watch window ended without a qualifying setup." }
              : token.critical
                ? { label: "AVOID", cls: "bg-loss/20 text-loss", why: "A critical risk flag fired — this blocks buying outright." }
                : { label: "AVOID", cls: "bg-loss/20 text-loss", why: "A safety gate failed — likely-scam or fundamentally unsafe conditions only (see the rule trace below)." };

  const summary =
    `Scored ${score ?? "—"}/100${threshold != null ? ` against a ≥${threshold} acceptance threshold` : ""}` +
    `${token.confidence != null ? `, with ${token.confidence}% of decision inputs available` : ""}. ` +
    (token.verdict === "REJECTED"
      ? `Safety gate failed: ${token.rejectionReasons.slice(0, 3).join("; ") || "see rules below"}.`
      : token.verdict === "WATCH"
        ? "Safe to trade but below your score threshold — watching."
        : token.verdict === "BOUGHT" || token.verdict === "BUY_CANDIDATE"
          ? `Accepted — ${token.greenFlags.slice(0, 3).join("; ") || "all rules passed"}.`
          : token.verdict === "IGNORED"
            ? "No decision was reached before the watch window expired."
            : "Evaluation in progress.") +
    (neutral.length > 0 ? ` ${neutral.length} input(s) had no data and scored neutral.` : "");

  return (
    <div className="rounded-lg border border-surface-border bg-surface-overlay/30 p-3 mb-3">
      <div className="flex items-center gap-3 flex-wrap mb-2">
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${action.cls}`}>{action.label}</span>
        <div className="flex-1 min-w-[140px]">
          <div className="h-2 bg-surface-overlay rounded-full overflow-hidden relative">
            <div
              className={`h-full rounded-full ${score != null && score >= 70 ? "bg-profit" : score != null && score >= 40 ? "bg-warn" : "bg-loss"}`}
              style={{ width: `${score ?? 0}%` }}
            />
            {threshold != null && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-slate-400"
                style={{ left: `${threshold}%` }}
                title={`Acceptance threshold: ${threshold}`}
              />
            )}
          </div>
        </div>
        <span className="font-mono text-xs text-slate-400">
          {score ?? "—"}/100{threshold != null ? ` (needs ≥${threshold})` : ""}
        </span>
      </div>
      <p className="text-xs text-slate-400 mb-1">{action.why}</p>
      <p className="text-xs text-slate-500">{summary}</p>
      <div className="flex gap-4 mt-2 text-[10px] text-slate-600">
        <span title="Tokens are re-evaluated continuously inside the 45-minute watch window.">
          {monitored ? "● Monitoring live" : "○ No longer monitored"}
        </span>
        {token.snapshot?.at && <span>last evaluated {timeAgo(token.snapshot.at)} ago</span>}
        {token.confidence != null && (
          <span title="Share of the decision inputs (price, liquidity, holders, authorities, …) that had data at evaluation time.">
            confidence {token.confidence}%
          </span>
        )}
        {neutral.length > 0 && (
          <span title={`No data for: ${neutral.join(", ")} — these scored neutral (0.5), never bullish.`}>
            {neutral.length} input(s) missing data
          </span>
        )}
      </div>

      {token.decisionTrace && token.decisionTrace.length > 0 && (
        <div className="mt-3 pt-3 border-t border-surface-border/50">
          <div
            className="stat-label mb-2"
            title="Every rule the execution engine evaluated. HARD rules (safety gates) can reject a token; advisory rules only inform the score and this display."
          >
            Execution rule trace
          </div>
          <div className="space-y-1">
            {token.decisionTrace.map((r) => (
              <div key={r.rule} className="flex items-start gap-2 text-xs">
                <span className={r.passed ? "text-profit" : r.hard ? "text-loss" : "text-warn"}>
                  {r.passed ? "✓" : "✗"}
                </span>
                <span className="w-36 shrink-0 text-slate-400">{r.rule}</span>
                <span
                  className={`shrink-0 text-[9px] px-1 rounded uppercase ${
                    r.hard ? "bg-loss/10 text-loss" : "bg-surface-overlay text-slate-500"
                  }`}
                  title={r.hard ? "Safety gate — failure rejects the token" : "Advisory — informs the score and risk display, never rejects"}
                >
                  {r.hard ? "hard" : r.layer === "opportunity" ? "score" : "advisory"}
                </span>
                <span className="text-slate-500 min-w-0">{r.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TokenDrawer({ token, threshold }: { token: TokenRow | null; threshold: number | null }) {
  const { data: detail } = usePoll<TokenDetail>(
    token ? `/api/tokens/${token.mint}` : "/api/tokens?limit=0",
    10_000
  );
  if (!token) return null;

  const points: PricePoint[] = (detail?.snapshots ?? [])
    .filter((s) => s.priceUsd != null)
    .map((s) => ({
      time: Math.floor(new Date(s.at).getTime() / 1000),
      price: s.priceUsd!,
      volume: s.volume5mUsd,
    }));
  const markers: TradeMarker[] = (detail?.trades ?? []).map((t) => ({
    time: Math.floor(new Date(t.createdAt).getTime() / 1000),
    side: t.side as "BUY" | "SELL",
    label: t.side,
  }));

  const links: Array<{ label: string; href: string }> = [
    { label: "Pump.fun", href: `https://pump.fun/coin/${token.mint}` },
    { label: "DexScreener", href: `https://dexscreener.com/solana/${token.mint}` },
    { label: "Raydium", href: `https://raydium.io/swap/?inputMint=sol&outputMint=${token.mint}` },
    { label: "GMGN", href: `https://gmgn.ai/sol/token/${token.mint}` },
    { label: "Solscan", href: `https://solscan.io/token/${token.mint}` },
    { label: "Birdeye", href: `https://birdeye.so/token/${token.mint}?chain=solana` },
    { label: "X", href: token.twitterUrl ?? `https://x.com/search?q=${token.mint}` },
    ...(token.websiteUrl ? [{ label: "Website", href: token.websiteUrl }] : []),
    ...(token.telegramUrl ? [{ label: "Telegram", href: token.telegramUrl }] : []),
  ];

  return (
    <div className="card mt-4 animate-slide-in">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-3 min-w-0">
          {token.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={token.imageUrl} alt="" className="w-10 h-10 rounded-full bg-surface-overlay object-cover" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-surface-overlay flex items-center justify-center text-xs text-slate-500">
              {(token.symbol ?? token.mint).slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-slate-200">
              {token.symbol ?? shortMint(token.mint)}
              {token.name && <span className="text-slate-500 text-sm ml-2">{token.name}</span>}
            </div>
            <div className="font-mono text-xs text-slate-500 flex items-center gap-1">
              {shortMint(token.mint)} <CopyButton text={token.mint} />
              <span className="text-slate-600 ml-2">migrated {timeAgo(token.migratedAt)} ago</span>
            </div>
          </div>
        </div>
        <ScoreBadge score={token.score} critical={token.critical} />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost text-[10px] !px-2 !py-0.5"
          >
            {l.label} ↗
          </a>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3 text-xs">
        <div><div className="stat-label">Price</div><div className="font-mono text-slate-300">{token.snapshot?.priceUsd ? `$${token.snapshot.priceUsd.toPrecision(3)}` : "—"}</div></div>
        <div><div className="stat-label">Market cap</div><div className="font-mono text-slate-300">{token.snapshot?.marketCapUsd ? `$${Math.round(token.snapshot.marketCapUsd / 1000)}k` : "—"}</div></div>
        <div><div className="stat-label">Liquidity</div><div className="font-mono text-slate-300">{token.snapshot?.liquiditySol ? `${token.snapshot.liquiditySol.toFixed(0)} SOL` : "—"}</div></div>
        <div><div className="stat-label">Holders</div><div className="font-mono text-slate-300">{token.snapshot?.holderCount ?? "—"}</div></div>
      </div>

      <DecisionPanel token={token} threshold={threshold} />

      <PriceChart points={points} markers={markers} />

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div>
          <div className="stat-label mb-2">Flags</div>
          <div className="space-y-2">
            <FlagPills flags={token.greenFlags} kind="green" />
            <FlagPills flags={token.redFlags} kind="red" />
            {token.greenFlags.length === 0 && token.redFlags.length === 0 && (
              <p className="text-xs text-slate-600">No flags recorded yet</p>
            )}
          </div>
          {token.rejectionReasons.length > 0 && (
            <div className="mt-3">
              <div className="stat-label mb-1 text-loss">Why the bot did not buy</div>
              <ul className="text-xs text-slate-400 space-y-0.5 list-disc list-inside">
                {token.rejectionReasons.map((r) => (
                  <li key={r}>✗ {r}</li>
                ))}
              </ul>
            </div>
          )}
          {token.verdict === "BOUGHT" && (
            <div className="mt-3">
              <div className="stat-label mb-1 text-profit">Why the bot bought</div>
              <ul className="text-xs text-slate-400 space-y-0.5 list-disc list-inside">
                <li>✓ Score {token.score ?? "—"} passed every configured buy rule</li>
                {(detail?.trades ?? [])
                  .filter((t) => t.side === "BUY")
                  .slice(0, 1)
                  .map((t) => (
                    <li key={t.createdAt}>✓ {t.reason}</li>
                  ))}
                {token.greenFlags.slice(0, 4).map((f) => (
                  <li key={f}>✓ {f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          <div className="stat-label mb-2" title="Every rule that fired, its measured value, and the exact points it contributed — weight × quality. This is the complete scoring math; nothing is hidden.">
            Score breakdown (weight × quality = points)
          </div>
          <div className="space-y-1.5">
            {(token.breakdown ?? []).map((m) => (
              <div key={m.metric} className="flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 text-slate-400">{m.metric}</span>
                <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${m.value >= 0.7 ? "bg-profit" : m.value >= 0.4 ? "bg-warn" : "bg-loss"}`}
                    style={{ width: `${m.value * 100}%` }}
                  />
                </div>
                <span
                  className={`w-14 shrink-0 font-mono text-right ${m.value >= 0.7 ? "text-profit" : m.value >= 0.4 ? "text-slate-400" : "text-loss"}`}
                  title={`quality ${(m.value * 100).toFixed(0)}% of weight ${m.weight}`}
                >
                  {m.contribution.toFixed(1)}/{m.weight}
                </span>
                <span className="w-36 shrink-0 text-slate-500 truncate" title={m.detail}>
                  {m.detail}
                </span>
              </div>
            ))}
            {!token.breakdown && <p className="text-xs text-slate-600">Not scored yet</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

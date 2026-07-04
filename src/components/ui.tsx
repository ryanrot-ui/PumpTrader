"use client";

/** Small shared presentational pieces used across pages. */

export function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "profit" | "loss" | "neutral";
}) {
  const color =
    tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-slate-100";
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className={`text-2xl font-semibold mt-1 font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

export function ScoreBadge({ score, critical }: { score: number | null; critical?: boolean }) {
  if (score === null) return <span className="text-slate-600">—</span>;
  const cls = critical
    ? "bg-loss/20 text-loss border-loss/40"
    : score >= 85
      ? "bg-profit/20 text-profit border-profit/40"
      : score >= 60
        ? "bg-warn/20 text-warn border-warn/40"
        : "bg-surface-overlay text-slate-400 border-surface-border";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md border text-xs font-mono font-semibold ${cls}`}>
      {score}
    </span>
  );
}

export function FlagPills({ flags, kind }: { flags: string[]; kind: "green" | "red" }) {
  if (flags.length === 0) return null;
  const cls =
    kind === "green"
      ? "bg-profit/10 text-profit border-profit/30"
      : "bg-loss/10 text-loss border-loss/30";
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} className={`px-1.5 py-0.5 rounded border text-[10px] ${cls}`}>
          {kind === "green" ? "✓" : "✗"} {f}
        </span>
      ))}
    </div>
  );
}

export function Sol({ value, sign = false }: { value: number | null | undefined; sign?: boolean }) {
  if (value === null || value === undefined) return <span className="text-slate-600">—</span>;
  const tone = value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-slate-300";
  return (
    <span className={`font-mono ${sign ? tone : ""}`}>
      {sign && value > 0 ? "+" : ""}
      {value.toFixed(4)} SOL
    </span>
  );
}

export function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function timeAgo(iso: string | Date): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

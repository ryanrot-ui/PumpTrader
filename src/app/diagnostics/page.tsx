"use client";

import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { shortMint, timeAgo } from "@/components/ui";

interface Diagnostics {
  db: { connected: boolean; latencyMs: number | null; schemaReady: boolean; error: string | null };
  redis: { configured: boolean; connected: boolean | null };
  engine: {
    alive: boolean;
    status: string;
    heartbeatAgoMs: number | null;
    readOnly: boolean;
    rpcUrl: string | null;
    rpcLatencyMs: number | null;
    scannerSubscribed: boolean | null;
    lastScanAt: number | null;
    tokensDetected: number | null;
    settingsLoadedAt: number | null;
  } | null;
  settings: {
    preset: string;
    updatedAt: number;
    engineInSync: boolean;
    thresholds: Record<string, number | boolean | null>;
  } | null;
  scoring: {
    lastSuccess: { at: number; mint: string | null; symbol: string | null; total: number } | null;
    lastFailure: { at: number; message: string; meta: Record<string, unknown> | null } | null;
  } | null;
  lastError: { at: number; source: string; message: string; meta: Record<string, unknown> | null } | null;
  version: { commit: string | null; node: string };
}

function Row({ label, value, ok }: { label: string; value: React.ReactNode; ok?: boolean | null }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 border-b border-surface-border/40 last:border-0 text-xs">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={`text-right break-all ${ok === false ? "text-loss" : ok === true ? "text-profit" : "text-slate-300"}`}>
        {value}
      </span>
    </div>
  );
}

export default function DiagnosticsPage() {
  const { data: d } = usePoll<Diagnostics>("/api/diagnostics", 10_000);

  return (
    <AppShell>
      <h1 className="text-xl font-semibold mb-1">Diagnostics</h1>
      <p className="text-sm text-slate-500 mb-4">
        Live measurements of every layer — refreshes every 10 seconds. If something on the
        dashboard looks wrong, this page says which layer broke.
      </p>

      {!d && <p className="text-sm text-slate-600">Loading…</p>}

      {d && (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div className="card">
            <div className="stat-label mb-2">Infrastructure</div>
            <Row label="PostgreSQL" ok={d.db.connected} value={d.db.connected ? `connected · ${d.db.latencyMs}ms` : d.db.error ?? "unreachable"} />
            <Row label="Schema" ok={d.db.schemaReady} value={d.db.schemaReady ? "initialized" : "missing"} />
            <Row
              label="Redis"
              ok={d.redis.configured ? d.redis.connected : null}
              value={d.redis.configured ? (d.redis.connected ? "connected" : "configured but unreachable") : "not configured (PostgreSQL-only mode — fully supported)"}
            />
            <Row label="Deployed commit" value={d.version.commit ? d.version.commit.slice(0, 10) : "unknown"} />
            <Row label="Node" value={d.version.node} />
          </div>

          <div className="card">
            <div className="stat-label mb-2">Engine worker</div>
            {d.engine ? (
              <>
                <Row label="Heartbeat" ok={d.engine.alive} value={d.engine.heartbeatAgoMs != null ? `${(d.engine.heartbeatAgoMs / 1000).toFixed(0)}s ago · ${d.engine.status}` : "never"} />
                <Row label="Read-only" value={d.engine.readOnly ? "yes" : "no"} />
                <Row label="RPC" ok={d.engine.rpcLatencyMs != null} value={d.engine.rpcLatencyMs != null ? `${d.engine.rpcLatencyMs}ms` : "unknown"} />
                <Row label="Realtime subscription" ok={d.engine.scannerSubscribed} value={d.engine.scannerSubscribed ? "live" : "polling fallback"} />
                <Row label="Last scan" value={d.engine.lastScanAt ? `${timeAgo(new Date(d.engine.lastScanAt))} ago` : "never"} />
                <Row label="Tokens detected" value={d.engine.tokensDetected ?? "—"} />
              </>
            ) : (
              <p className="text-xs text-slate-600">Unavailable while the database is unreachable.</p>
            )}
          </div>

          <div className="card">
            <div className="stat-label mb-2">Strategy & settings</div>
            {d.settings ? (
              <>
                <Row
                  label="Active preset"
                  ok={d.settings.preset === "momentum-scalping" ? true : null}
                  value={d.settings.preset === "momentum-scalping" ? "Momentum scalping" : "Custom"}
                />
                <Row label="Settings changed" value={`${timeAgo(new Date(d.settings.updatedAt))} ago`} />
                <Row
                  label="Engine reloaded them"
                  ok={d.settings.engineInSync}
                  value={d.settings.engineInSync ? "in sync" : d.engine?.settingsLoadedAt ? `stale (engine on version from ${timeAgo(new Date(d.engine.settingsLoadedAt))} ago)` : "unknown — engine hasn't reported"}
                />
                {Object.entries(d.settings.thresholds).map(([k, v]) => (
                  <Row key={k} label={k} value={v === null ? "off" : String(v)} />
                ))}
              </>
            ) : (
              <p className="text-xs text-slate-600">No settings row yet.</p>
            )}
          </div>

          <div className="card md:col-span-2 xl:col-span-3">
            <div className="stat-label mb-2">Scoring pipeline</div>
            {d.scoring?.lastSuccess ? (
              <Row
                label="Last successful score"
                ok={true}
                value={`${d.scoring.lastSuccess.symbol ?? shortMint(d.scoring.lastSuccess.mint ?? "")} → ${d.scoring.lastSuccess.total}/100, ${timeAgo(new Date(d.scoring.lastSuccess.at))} ago`}
              />
            ) : (
              <Row label="Last successful score" value="none yet" />
            )}
            {d.scoring?.lastFailure ? (
              <>
                <Row
                  label="Last failed score"
                  ok={false}
                  value={`${timeAgo(new Date(d.scoring.lastFailure.at))} ago — ${d.scoring.lastFailure.message}`}
                />
                {d.scoring.lastFailure.meta && (
                  <pre className="mt-2 font-mono text-[10px] text-slate-500 whitespace-pre-wrap break-all max-h-48 overflow-y-auto bg-surface-overlay/40 rounded p-2">
                    {JSON.stringify(d.scoring.lastFailure.meta, null, 2)}
                  </pre>
                )}
              </>
            ) : (
              <Row label="Last failed score" ok={true} value="no scoring failures recorded" />
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

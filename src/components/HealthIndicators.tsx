"use client";

import { useState } from "react";
import { timeAgo } from "@/components/ui";

/**
 * The engine/scanner health the dashboard cares about. Mirrors the JSON from
 * GET /api/health. All fields are nullable — the engine may not have written a
 * heartbeat yet (worker not deployed / still booting).
 */
export interface Health {
  /** false = the web service itself cannot reach PostgreSQL. */
  dbConnected?: boolean | null;
  dbError?: string | null;
  engineAlive: boolean;
  status: string;
  readOnly: boolean;
  rpcUrl: string | null;
  rpcConnected?: boolean | null;
  rpcLatencyMs: number | null;
  scannerSubscribed?: boolean | null;
  scannerLastEventAt: number | null;
  lastScanAt?: number | null;
  lastPollCount?: number | null;
  wsConnected?: boolean | null;
  usingPublicRpc?: boolean | null;
  scansPerMin: number | null;
  watchlistSize: number | null;
  tokensDetected?: number | null;
  scannerError?: string | null;
  lastTradeAt: number | null;
  memoryRssMb: number | null;
  lastError: {
    at: number;
    source: string;
    message: string;
    meta?: Record<string, unknown> | null;
  } | null;
}

/**
 * The most recent engine error, in full: complete message, structured
 * context (token, Prisma code, operation), expandable stack trace, exact
 * timestamp, and a copy button — never a truncated mystery.
 */
function LastErrorPanel({
  err,
}: {
  err: { at: number; source: string; message: string; meta?: Record<string, unknown> | null };
}) {
  const [copied, setCopied] = useState(false);
  const meta = err.meta ?? {};
  const stack = typeof meta.stack === "string" ? meta.stack : null;
  const context = Object.entries(meta).filter(([k]) => k !== "stack");
  const fullText = [
    `[${new Date(err.at).toISOString()}] [${err.source}] ${err.message}`,
    ...context.map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
    ...(stack ? ["", stack] : []),
  ].join("\n");

  return (
    <details className="mt-2 text-xs rounded-md border border-loss/30 bg-loss/5 px-3 py-2">
      <summary className="cursor-pointer text-loss list-none flex items-baseline gap-2 flex-wrap">
        <span>⚠</span>
        <span className="text-slate-500 shrink-0">{timeAgo(new Date(err.at))} ago</span>
        <span className="text-slate-500 shrink-0">[{err.source}]</span>
        <span className="min-w-0 break-all">{err.message}</span>
        <span className="text-slate-600 shrink-0">(click for details)</span>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="text-slate-500">{new Date(err.at).toLocaleString()}</div>
        {context.length > 0 && (
          <div className="space-y-0.5">
            {context.map(([k, v]) => (
              <div key={k} className="font-mono text-slate-400 break-all">
                <span className="text-slate-600">{k}:</span> {JSON.stringify(v)}
              </div>
            ))}
          </div>
        )}
        {stack && (
          <pre className="font-mono text-[10px] text-slate-500 whitespace-pre-wrap break-all max-h-48 overflow-y-auto bg-surface-overlay/40 rounded p-2">
            {stack}
          </pre>
        )}
        <button
          onClick={(e) => {
            e.preventDefault();
            void navigator.clipboard?.writeText(fullText).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="text-slate-400 hover:text-slate-200 border border-surface-border rounded px-2 py-0.5"
        >
          {copied ? "✓ Copied" : "Copy full error"}
        </button>
      </div>
    </details>
  );
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const color = ok ? "bg-profit" : warn ? "bg-warn" : "bg-loss";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

function Indicator({
  label,
  value,
  ok,
  warn,
  title,
}: {
  label: string;
  value: string;
  ok?: boolean;
  warn?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-2" title={title}>
      {ok !== undefined && <Dot ok={ok} warn={warn} />}
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-xs text-slate-200">{value}</div>
      </div>
    </div>
  );
}

/**
 * The five health indicators the operator needs to trust the scanner:
 * Engine Running · RPC Connected · Scanner Active · Last Scan · Tokens Detected.
 * When something is wrong it also renders the exact reason so an empty token
 * list is never unexplained.
 */
export function HealthIndicators({ health }: { health: Health | null | undefined }) {
  const dbDown = health?.dbConnected === false;
  const engineAlive = !!health?.engineAlive;
  // Scanner is "active" when the engine is alive and a poll cycle completed
  // recently (the reliable HTTP path) OR the realtime websocket is connected.
  const lastScan = health?.lastScanAt ?? health?.scannerLastEventAt ?? null;
  const scanFresh = lastScan != null && Date.now() - lastScan < 90_000;
  const scannerActive = engineAlive && (scanFresh || !!health?.wsConnected);
  const rpcConnected = health?.rpcConnected ?? (health?.rpcLatencyMs != null);

  return (
    <div className="card mb-4 p-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Indicator
          label="Engine Running"
          ok={engineAlive}
          value={dbDown ? "Unknown" : engineAlive ? (health?.readOnly ? "Running · read-only" : "Running") : "Offline"}
          title={
            dbDown
              ? "Heartbeats live in the database, which is unreachable — engine state is unknown."
              : engineAlive
                ? "The trading engine worker is sending heartbeats."
                : "No recent heartbeat — the engine worker is not running."
          }
        />
        <Indicator
          label="RPC Connected"
          ok={rpcConnected}
          warn={rpcConnected && !!health?.usingPublicRpc}
          value={
            rpcConnected
              ? `${health?.rpcLatencyMs != null ? `${health.rpcLatencyMs}ms` : "ok"}${health?.usingPublicRpc ? " · public" : ""}`
              : "Disconnected"
          }
          title={health?.rpcUrl ?? undefined}
        />
        <Indicator
          label="Scanner Active"
          ok={scannerActive}
          warn={engineAlive && !scannerActive}
          value={
            scannerActive
              ? health?.wsConnected
                ? "Realtime + poll"
                : "Polling"
              : engineAlive
                ? "Stalled"
                : "—"
          }
          title={
            health?.wsConnected
              ? "Realtime websocket subscription is live."
              : "Realtime websocket unavailable — using the 30s HTTP polling fallback."
          }
        />
        <Indicator
          label="Last Scan"
          ok={scanFresh}
          warn={engineAlive && !scanFresh}
          value={lastScan ? `${timeAgo(new Date(lastScan))} ago` : "never"}
          title={health?.lastPollCount != null ? `${health.lastPollCount} signatures in the last poll` : undefined}
        />
        <Indicator
          label="Tokens Detected"
          ok={(health?.tokensDetected ?? 0) > 0}
          warn={engineAlive && (health?.tokensDetected ?? 0) === 0}
          value={health?.tokensDetected != null ? String(health.tokensDetected) : "—"}
          title="Total migrations written to the database."
        />
      </div>

      {/* Exact reason when detection is impaired */}
      {engineAlive && health?.usingPublicRpc && (
        <div className="mt-3 text-xs rounded-md border border-warn/40 bg-warn/10 text-warn px-3 py-2">
          Using the public Solana RPC. It rejects the realtime scanner websocket and rate-limits polling,
          so token detection is slow or empty. Set <code className="font-mono">SOLANA_RPC_URL</code>
          {" "}(and <code className="font-mono">SOLANA_WS_URL</code>) to a dedicated provider — e.g. a free
          Helius key — on both the web and engine services.
        </div>
      )}
      {engineAlive && health?.scannerError && (
        <div className="mt-2 text-xs rounded-md border border-loss/40 bg-loss/10 text-loss px-3 py-2">
          Scanner RPC error: {health.scannerError}
        </div>
      )}
      {dbDown && (
        <div className="mt-3 text-xs rounded-md border border-loss/40 bg-loss/10 text-loss px-3 py-2">
          The web service cannot reach its PostgreSQL database
          {health?.dbError ? <> (<span className="font-mono">{health.dbError}</span>)</> : null}. Engine
          status is unknown until the database is back. On Neon: open the console and check that the
          compute is <em>Active</em> (free-plan computes stop when the monthly quota is used up), and
          that <span className="font-mono">DATABASE_URL</span> on both Render services matches the
          current connection string shown in Neon.
        </div>
      )}
      {!engineAlive && !dbDown && (
        <div className="mt-3 text-xs rounded-md border border-loss/40 bg-loss/10 text-loss px-3 py-2">
          The engine worker isn’t reporting. On Render, confirm the{" "}
          <span className="font-mono">pumptrader-engine</span> worker is deployed and running with the
          same <span className="font-mono">DATABASE_URL</span> as the web service.
        </div>
      )}
      {health?.lastError && <LastErrorPanel err={health.lastError} />}
    </div>
  );
}

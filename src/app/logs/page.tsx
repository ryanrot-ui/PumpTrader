"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";

interface LogRow {
  id: string;
  at: string;
  level: string;
  source: string;
  message: string;
  meta: Record<string, unknown> | null;
}

const LEVELS = ["all", "info", "warn", "error"] as const;

export default function LogsPage() {
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");
  const { data: logs } = usePoll<LogRow[]>(
    `/api/logs?limit=200${level !== "all" ? `&level=${level}` : ""}`,
    5000
  );

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Logs</h1>
        <div className="flex gap-1.5">
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`btn text-xs ${level === l ? "btn-primary" : "btn-ghost"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="card font-mono text-xs space-y-1 max-h-[75vh] overflow-y-auto">
        {(logs ?? []).map((l) => (
          <div key={l.id} className="flex gap-2 py-0.5 border-b border-surface-border/30">
            <span className="text-slate-600 shrink-0 w-40">
              {new Date(l.at).toLocaleString()}
            </span>
            <span
              className={`shrink-0 w-12 ${
                l.level === "error" ? "text-loss" : l.level === "warn" ? "text-warn" : "text-slate-500"
              }`}
            >
              {l.level}
            </span>
            <span className="text-accent shrink-0 w-20">[{l.source}]</span>
            <span className="text-slate-300 break-all">
              {l.message}
              {l.meta && (
                <span className="text-slate-600 ml-2">{JSON.stringify(l.meta)}</span>
              )}
            </span>
          </div>
        ))}
        {(!logs || logs.length === 0) && <p className="text-slate-600 py-4">No log entries</p>}
      </div>
    </AppShell>
  );
}

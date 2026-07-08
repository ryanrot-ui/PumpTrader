import { getEngineState, engineLeaseAvailable, claimEngineLease } from "@/lib/engineState";
import { TradingEngine } from "@/engine/engine";
import { engineRunnerSecret } from "./lib/secret";

/**
 * Scheduled every minute (see netlify.toml). Keeps the trading engine alive
 * on Netlify's serverless model:
 *
 *   1. If an engine cycle currently holds the DB lease (fresh EngineState
 *      heartbeat), do nothing — the engine is running.
 *   2. Otherwise launch the full-fidelity Background Function runner
 *      (engine-runner-background: 5s position monitoring, polling scanner,
 *      ~13-minute cycles).
 *   3. If the Background Function cannot be launched (e.g. a plan without
 *      background functions), fall back to one bounded engine pass inline —
 *      degraded (positions checked once a minute) but never dark: exits,
 *      scanning and buying all still happen.
 *
 * The engine trades only when the operator has enabled it (Settings →
 * botEnabled); an idle engine cycle just heartbeats and scans.
 */
export default async () => {
  const state = await getEngineState();
  if (!engineLeaseAvailable(state)) {
    return new Response(JSON.stringify({ ok: true, action: "runner-active" }), { status: 200 });
  }

  const base = process.env.URL;
  if (base) {
    try {
      const res = await fetch(`${base}/.netlify/functions/engine-runner-background`, {
        method: "POST",
        headers: { "x-engine-key": engineRunnerSecret() },
      });
      // Background functions acknowledge with 202 and run detached.
      if (res.status === 202 || res.ok) {
        return new Response(JSON.stringify({ ok: true, action: "runner-launched" }), { status: 200 });
      }
      console.warn(`[engine-tick] background runner returned ${res.status} — running inline fallback tick`);
    } catch (e) {
      console.warn(`[engine-tick] background runner unreachable (${(e as Error).message}) — running inline fallback tick`);
    }
  }

  // Degraded inline pass. Claim the lease atomically first so two ticks (or
  // a tick racing a slow-booting runner) can never operate concurrently.
  if (!(await claimEngineLease())) {
    return new Response(JSON.stringify({ ok: true, action: "lease-contended" }), { status: 200 });
  }
  const engine = new TradingEngine({ pollOnlyScanner: true });
  await engine.runOnce(8_000);
  return new Response(JSON.stringify({ ok: true, action: "inline-tick" }), { status: 200 });
};

export const config = {
  schedule: "* * * * *",
};

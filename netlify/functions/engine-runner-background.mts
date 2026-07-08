import { claimEngineLease } from "@/lib/engineState";
import { TradingEngine } from "@/engine/engine";
import { engineRunnerSecret } from "./lib/secret";

/**
 * Full-fidelity engine cycle as a Netlify Background Function (15-minute
 * execution window). Launched by the per-minute engine-tick scheduled
 * function whenever no cycle holds the DB lease.
 *
 * Runs the complete TradingEngine — 5-second position monitoring, polling
 * migration scanner with a persisted cursor, hot-reloading settings,
 * emergency-stop control queue — for ~13 minutes, then exits with status
 * "idle" so the next tick relaunches immediately. All state is in Postgres;
 * a cycle boundary loses nothing.
 */
const CYCLE_MS = 13 * 60_000; // leave a 2-minute shutdown margin inside the 15-minute cap

export default async (req: Request) => {
  // The endpoint is publicly routable — only the scheduler may invoke it.
  if (req.headers.get("x-engine-key") !== engineRunnerSecret()) {
    return new Response("forbidden", { status: 403 });
  }

  // Atomic lease claim: with live trading, two concurrent engines monitoring
  // the same positions could double-sell. Losing the race is normal (another
  // runner is active) and not an error.
  if (!(await claimEngineLease())) {
    console.log("[engine-runner] lease held by an active cycle — exiting");
    return new Response("lease-contended", { status: 200 });
  }

  const engine = new TradingEngine({ pollOnlyScanner: true });
  try {
    await engine.runFor(CYCLE_MS);
  } catch (e) {
    console.error(`[engine-runner] cycle failed: ${(e as Error).message}`);
    // Leave the lease claimable so the next tick restarts the engine.
    await engine.stop("idle").catch(() => {});
    return new Response("cycle-error", { status: 500 });
  }
  return new Response("cycle-complete", { status: 200 });
};

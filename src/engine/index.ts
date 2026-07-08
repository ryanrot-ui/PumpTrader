import { validateEnv } from "@/lib/env";
import { TradingEngine } from "./engine";
import { logger } from "./logging/logger";

/**
 * Long-running trading engine worker — for a VPS, a local machine, or any
 * host that can keep a Node process alive:
 *   npm run engine        (mode from settings; paper by default)
 *
 * Serverless deployments (Netlify) do NOT use this entry point — the engine
 * runs as bounded cycles driven by netlify/functions/engine-tick.mts.
 */

// @solana/web3.js prints every websocket reconnect failure straight to
// console.error ("ws error: …") with no way to configure it, flooding logs
// during an RPC outage. Throttle that one message to once per minute; every
// other console.error passes through untouched (the health probe still
// surfaces RPC trouble on the dashboard).
const rawConsoleError = console.error.bind(console);
let lastWsErrorAt = 0;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("ws error")) {
    if (Date.now() - lastWsErrorAt < 60_000) return;
    lastWsErrorAt = Date.now();
  }
  rawConsoleError(...args);
};

validateEnv("engine");
const engine = new TradingEngine();

// No silent failures: anything unhandled is logged with a stack trace, then
// the process exits so the supervisor restarts it and crash recovery rebuilds
// state from Postgres.
process.on("unhandledRejection", (reason) => {
  logger.exception("engine", "unhandled rejection", reason);
});
process.on("uncaughtException", (err) => {
  logger.exception("engine", "uncaught exception — exiting for supervisor restart", err);
  setTimeout(() => process.exit(1), 500);
});

async function main() {
  await engine.start();
  const shutdown = async (sig: string) => {
    logger.info("engine", `${sig} received, shutting down`);
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.exception("engine", "fatal startup error", e);
  process.exit(1);
});

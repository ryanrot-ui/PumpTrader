import { prisma } from "@/lib/prisma";
import { redisEnabled, subscribe, CHANNELS } from "@/lib/redis";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const DB_POLL_MS = 3_000;

/**
 * Server-Sent Events stream of the engine's live feed. With Redis configured
 * the stream bridges the pub/sub channel (instant); without it, it tails the
 * log table on a short poll — same events, slightly higher latency.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let ping: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | null = null;
  const cleanup = () => {
    if (ping) clearInterval(ping);
    if (poll) clearInterval(poll);
    unsubscribe?.();
    unsubscribe = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          cleanup(); // client went away
        }
      };

      if (redisEnabled) {
        unsubscribe = subscribe(CHANNELS.liveFeed, send);
      } else {
        let lastSeen = new Date();
        poll = setInterval(() => {
          void prisma.logEntry
            .findMany({
              where: { at: { gt: lastSeen } },
              orderBy: { at: "asc" },
              take: 50,
            })
            .then((rows) => {
              for (const row of rows) {
                lastSeen = row.at;
                send(
                  JSON.stringify({
                    at: row.at.getTime(),
                    level: row.level,
                    source: row.source,
                    message: row.message,
                    meta: row.meta,
                  })
                );
              }
            })
            .catch(() => {});
        }, DB_POLL_MS);
      }

      ping = setInterval(() => send(JSON.stringify({ ping: Date.now() })), 25_000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

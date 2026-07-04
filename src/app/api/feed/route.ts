import { redis, KEYS } from "@/lib/redis";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of the engine's live feed (Redis pub/sub bridge).
 * The dashboard subscribes here for real-time logs/trades without polling.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const sub = redis.duplicate();
  await sub.subscribe(KEYS.liveFeed);

  let ping: NodeJS.Timeout;
  const cleanup = () => {
    clearInterval(ping);
    sub.unsubscribe().catch(() => {});
    sub.disconnect();
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
      sub.on("message", (_ch, msg) => send(msg));
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

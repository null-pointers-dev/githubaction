import { apiUser } from "@/server/session";
import { newRedis } from "@/server/redis";
import { TOPIC_PATTERN } from "@/server/pubsub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events: forwards Redis pub/sub messages for the requested topics. */
export async function GET(req: Request) {
  const user = await apiUser(req);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const topics = (new URL(req.url).searchParams.get("topics") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => TOPIC_PATTERN.test(t))
    .slice(0, 10);
  if (topics.length === 0) return new Response("No valid topics", { status: 400 });

  const sub = newRedis();
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    sub.quit().catch(() => sub.disconnect());
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      sub.on("message", (channel: string, message: string) => {
        send(`data: ${JSON.stringify({ topic: channel.replace(/^fd:/, ""), message: safeJson(message) })}\n\n`);
      });
      sub.on("error", () => undefined);
      await sub.subscribe(...topics.map((t) => `fd:${t}`));
      send(`retry: 5000\n: connected\n\n`);
      heartbeat = setInterval(() => send(`: keep-alive\n\n`), 25_000);
      req.signal.addEventListener("abort", () => {
        close();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

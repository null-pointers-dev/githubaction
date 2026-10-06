import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/server/db";
import { webhookInbox } from "@/server/db/schema";
import { enqueue } from "@/server/queues";
import { config } from "@/server/config";
import { KEYS, redis } from "@/server/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function signatureValid(body: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header);
  return config.webhookSecrets.some((secret) => {
    const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** Verify, store, enqueue, acknowledge. All processing happens in the worker. */
export async function POST(req: Request) {
  const body = await req.text();
  if (!signatureValid(body, req.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid signature", { status: 401 });
  }
  const deliveryId = req.headers.get("x-github-delivery");
  const event = req.headers.get("x-github-event");
  if (!deliveryId || !event) return new Response("Missing GitHub headers", { status: 400 });
  if (event === "ping") return new Response("pong", { status: 200 });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Body is not JSON. Set the webhook content type to application/json.", { status: 400 });
  }

  try {
    await db
      .insert(webhookInbox)
      .values({
        deliveryId,
        event,
        action: typeof payload.action === "string" ? payload.action : null,
        installationId: Number((payload.installation as { id?: number } | undefined)?.id) || null,
        payload,
      })
      .onConflictDoNothing();
    await enqueue.ingest(deliveryId);
    await redis().set(KEYS.webhookLast, String(Date.now()));
  } catch (err) {
    console.error("[webhook] could not store delivery", deliveryId, err);
    // 503 makes the delivery show as failed, so the redelivery job picks it up.
    return new Response("Temporarily unavailable", { status: 503 });
  }
  return new Response(null, { status: 202 });
}

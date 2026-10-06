import type { Job } from "bullmq";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "@/server/db";
import { githubCredentials, webhookInbox } from "@/server/db/schema";
import { appOctokitFor, gh, githubMessage, octokitFor } from "@/server/github/client";
import { enqueue, type MaintenanceJob } from "@/server/queues";
import { KEYS, redis } from "@/server/redis";
import { log } from "./context";

export async function maintenanceProcessor(job: Job<MaintenanceJob>) {
  if (job.data.kind === "verify-credential") return verifyCredential(job.data.credentialId);
  if (job.data.kind === "housekeeping") return housekeeping();
}

/** Confirms a connection works and records which GitHub identity it acts as. */
async function verifyCredential(id: string) {
  const [cred] = await db.select().from(githubCredentials).where(eq(githubCredentials.id, id));
  if (!cred) return;
  const now = new Date();
  try {
    let tokenLogin: string | null = null;
    let expiresAt: Date | null = null;
    if (cred.kind === "pat") {
      const res = await gh<{ login: string }>(octokitFor(cred), "GET /user");
      tokenLogin = res.data.login;
      const exp = res.headers["github-authentication-token-expiration"];
      if (exp) {
        const parsed = new Date(exp.replace(" UTC", "Z").replace(" ", "T"));
        expiresAt = Number.isNaN(parsed.getTime()) ? null : parsed;
      }
    } else {
      const app = appOctokitFor(cred);
      if (!app) throw new Error("App ID or private key is missing.");
      const meta = await gh<{ slug: string }>(app, "GET /app");
      tokenLogin = `${meta.data.slug}[bot]`;
      await gh(octokitFor(cred), "GET /installation/repositories", { per_page: 1 });
    }
    const soon = expiresAt && expiresAt.getTime() - now.getTime() < 14 * 24 * 3600 * 1000;
    await db
      .update(githubCredentials)
      .set({ tokenLogin, expiresAt, status: soon ? "expiring" : "healthy", lastError: null, lastVerifiedAt: now })
      .where(eq(githubCredentials.id, id));
    log("maintenance", `verified ${cred.name}`, { as: tokenLogin });
    if (cred.purpose === "dispatch") await enqueue.syncOwner(cred.id);
  } catch (e) {
    await db.update(githubCredentials).set({ status: "error", lastError: githubMessage(e), lastVerifiedAt: now }).where(eq(githubCredentials.id, id));
  }
}

async function housekeeping() {
  const now = Date.now();

  // Flag tokens that expire within 14 days.
  const creds = await db.select().from(githubCredentials);
  for (const c of creds) {
    if (c.expiresAt && c.status === "healthy" && c.expiresAt.getTime() - now < 14 * 24 * 3600 * 1000) {
      await db.update(githubCredentials).set({ status: "expiring" }).where(eq(githubCredentials.id, c.id));
    }
  }

  // Prune processed webhook payloads after 14 days.
  await db.delete(webhookInbox).where(and(isNotNull(webhookInbox.processedAt), lt(webhookInbox.receivedAt, new Date(now - 14 * 24 * 3600 * 1000))));

  // GitHub never retries failed webhook deliveries. For GitHub App webhooks, redeliver them.
  const checkpoint = Number((await redis().get(KEYS.redeliveryCheckpoint)) ?? now - 3600_000);
  for (const c of creds.filter((x) => x.kind === "app" && x.purpose === "dispatch")) {
    const app = appOctokitFor(c);
    if (!app) continue;
    try {
      const res = await gh<Array<{ id: number; guid: string; status_code: number; delivered_at: string; redelivery: boolean }>>(app, "GET /app/hook/deliveries", { per_page: 100 });
      const failed = res.data.filter((d) => (d.status_code < 200 || d.status_code >= 300) && Date.parse(d.delivered_at) > checkpoint && !d.redelivery);
      const guids = failed.map((f) => f.guid);
      const known = guids.length ? await db.select({ id: webhookInbox.deliveryId }).from(webhookInbox).where(inArray(webhookInbox.deliveryId, guids)) : [];
      const knownSet = new Set(known.map((k) => k.id));
      for (const f of failed) {
        if (knownSet.has(f.guid)) continue;
        await gh(app, "POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: f.id }).catch(() => undefined);
      }
      if (failed.length) log("maintenance", `asked GitHub to redeliver ${failed.length} failed webhooks`, { app: c.name });
    } catch (e) {
      log("maintenance", "couldn't list webhook deliveries", { app: c.name, error: githubMessage(e) });
    }
  }
  await redis().set(KEYS.redeliveryCheckpoint, String(now));
}

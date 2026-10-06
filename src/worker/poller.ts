import type { Job } from "bullmq";
import { and, eq, inArray, lt, notInArray } from "drizzle-orm";
import { db } from "@/server/db";
import { approvalRequests, runRequests, workflowRuns } from "@/server/db/schema";
import { enqueue, type PollerJob } from "@/server/queues";
import { KEYS, redis } from "@/server/redis";
import { TERMINAL_PHASES } from "@/lib/phases";
import { log } from "./context";

/**
 * Runs every 60 seconds whether or not webhooks work. It re-checks every run that
 * hasn't finished, so a lost or late webhook delays an update by at most a minute.
 * Runs a webhook touched in the last 30 seconds are skipped (unless forced).
 */
export async function pollerProcessor(job: Job<PollerJob>) {
  const force = !!job.data?.force;
  const now = Date.now();
  const webhookCutoff = new Date(now - 30_000);

  const active = await db
    .select({ repositoryId: workflowRuns.repositoryId, githubRunId: workflowRuns.githubRunId, lastWebhookAt: workflowRuns.lastWebhookAt })
    .from(workflowRuns)
    .where(notInArray(workflowRuns.phase, TERMINAL_PHASES))
    .limit(5000);

  let queued = 0;
  for (const r of active) {
    if (force || !r.lastWebhookAt || r.lastWebhookAt < webhookCutoff) {
      await enqueue.reconcile(r.repositoryId, r.githubRunId);
      queued++;
    }
  }

  // Dispatches whose outcome we never heard about.
  const stuck = await db
    .select({ id: runRequests.id, phase: runRequests.phase })
    .from(runRequests)
    .where(and(inArray(runRequests.phase, ["dispatching", "unknown", "pending"]), lt(runRequests.updatedAt, new Date(now - 90_000))));
  for (const s of stuck) {
    if (s.phase === "pending") await enqueue.dispatch(s.id);
    else await enqueue.resolve(s.id, 0, 0);
  }

  // Decisions that weren't delivered to GitHub (worker restart, GitHub outage).
  const deciding = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.state, "deciding"), lt(approvalRequests.updatedAt, new Date(now - 120_000))));
  for (const d of deciding) await enqueue.approvalDecide(d.id);

  await redis().set(KEYS.pollerLast, JSON.stringify({ at: now, active: active.length, queued, stuck: stuck.length, deciding: deciding.length }));
  if (queued || stuck.length || deciding.length) {
    log("poller", "tick", { active: active.length, queued, stuck: stuck.length, deciding: deciding.length });
  }
}

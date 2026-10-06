import { Queue, type JobsOptions } from "bullmq";
import { redisOptions } from "./redis";

export const QUEUE = {
  ingest: "fd-ingest",
  dispatch: "fd-dispatch",
  reconcile: "fd-reconcile",
  approval: "fd-approval",
  sync: "fd-sync",
  poller: "fd-poller",
  maintenance: "fd-maintenance",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export type RunAction = "cancel" | "rerun" | "rerun_failed" | "rerun_debug";

export type IngestJob = { deliveryId: string };
export type DispatchJob =
  | { kind: "dispatch"; runRequestId: string }
  | { kind: "resolve"; runRequestId: string; tries?: number }
  | { kind: "action"; runRequestId: string; action: RunAction; userId: string };
export type ReconcileJob = { repositoryId: string; githubRunId: number };
export type ApprovalJob =
  | { kind: "refresh"; repositoryId: string; githubRunId: number }
  | { kind: "decide"; approvalRequestId: string }
  | { kind: "team"; org: string; slug: string };
export type SyncJob = { kind: "all" } | { kind: "owner"; credentialId: string } | { kind: "repo"; repositoryId: string };
export type PollerJob = { force?: boolean };
export type MaintenanceJob = { kind: "verify-credential"; credentialId: string } | { kind: "housekeeping" };

const DEFAULTS: JobsOptions = {
  attempts: 8,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const g = globalThis as unknown as { __fdQueues?: Map<string, Queue> };

export function queue(name: QueueName): Queue {
  g.__fdQueues ??= new Map();
  let q = g.__fdQueues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisOptions(), defaultJobOptions: DEFAULTS });
    g.__fdQueues.set(name, q);
  }
  return q;
}

/**
 * Producers. Deduplication ids keep one queued job per resource; the short TTL
 * lets a later event queue a fresh reconcile once the burst has passed.
 * Job ids never contain ":" (BullMQ reserves it).
 */
export const enqueue = {
  ingest: (deliveryId: string) =>
    queue(QUEUE.ingest).add("ingest", { deliveryId } satisfies IngestJob, { jobId: `delivery-${deliveryId}` }),

  dispatch: (runRequestId: string) =>
    queue(QUEUE.dispatch).add("dispatch", { kind: "dispatch", runRequestId } satisfies DispatchJob, {
      deduplication: { id: `dispatch-${runRequestId}` },
      attempts: 3,
    }),

  resolve: (runRequestId: string, tries = 0, delay = 10_000) =>
    queue(QUEUE.dispatch).add("resolve", { kind: "resolve", runRequestId, tries } satisfies DispatchJob, {
      deduplication: { id: `resolve-${runRequestId}`, ttl: 5_000 },
      delay,
      attempts: 3,
    }),

  runAction: (runRequestId: string, action: RunAction, userId: string) =>
    queue(QUEUE.dispatch).add("action", { kind: "action", runRequestId, action, userId } satisfies DispatchJob, {
      deduplication: { id: `action-${runRequestId}-${action}`, ttl: 10_000 },
      attempts: 4,
    }),

  reconcile: (repositoryId: string, githubRunId: number, delay = 0) =>
    queue(QUEUE.reconcile).add("reconcile", { repositoryId, githubRunId } satisfies ReconcileJob, {
      deduplication: { id: `run-${githubRunId}`, ttl: 3_000 },
      delay,
    }),

  approvalRefresh: (repositoryId: string, githubRunId: number, delay = 0) =>
    queue(QUEUE.approval).add("refresh", { kind: "refresh", repositoryId, githubRunId } satisfies ApprovalJob, {
      deduplication: { id: `approvals-${githubRunId}`, ttl: 3_000 },
      delay,
    }),

  approvalDecide: (approvalRequestId: string) =>
    queue(QUEUE.approval).add("decide", { kind: "decide", approvalRequestId } satisfies ApprovalJob, {
      deduplication: { id: `decide-${approvalRequestId}` },
      attempts: 6,
    }),

  teamSync: (org: string, slug: string) =>
    queue(QUEUE.approval).add("team", { kind: "team", org, slug } satisfies ApprovalJob, {
      deduplication: { id: `team-${org}-${slug}`, ttl: 10 * 60_000 },
      attempts: 3,
    }),

  syncAll: () => queue(QUEUE.sync).add("all", { kind: "all" } satisfies SyncJob, { deduplication: { id: "sync-all", ttl: 30_000 } }),

  syncOwner: (credentialId: string) =>
    queue(QUEUE.sync).add("owner", { kind: "owner", credentialId } satisfies SyncJob, {
      deduplication: { id: `sync-owner-${credentialId}`, ttl: 30_000 },
    }),

  syncRepo: (repositoryId: string) =>
    queue(QUEUE.sync).add("repo", { kind: "repo", repositoryId } satisfies SyncJob, {
      deduplication: { id: `sync-repo-${repositoryId}`, ttl: 15_000 },
    }),

  pollNow: () =>
    queue(QUEUE.poller).add("manual", { force: true } satisfies PollerJob, { deduplication: { id: "poll-now", ttl: 10_000 } }),

  verifyCredential: (credentialId: string) =>
    queue(QUEUE.maintenance).add("verify", { kind: "verify-credential", credentialId } satisfies MaintenanceJob, {
      attempts: 3,
    }),
};

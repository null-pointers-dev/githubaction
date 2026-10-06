import { Worker, type Processor } from "bullmq";
import { QUEUE, queue } from "@/server/queues";
import { redisOptions } from "@/server/redis";
import { LockBusyError } from "@/server/lock";
import { pool } from "@/server/db";
import { ingestProcessor } from "./ingest";
import { dispatchProcessor } from "./dispatch";
import { reconcileProcessor } from "./reconcile";
import { approvalProcessor } from "./approval";
import { syncProcessor } from "./sync";
import { pollerProcessor } from "./poller";
import { maintenanceProcessor } from "./maintenance";
import { log } from "./context";

const connection = redisOptions();

function start(name: string, processor: Processor, concurrency: number, limiter?: { max: number; duration: number }) {
  const w = new Worker(name, processor, { connection, concurrency, limiter });
  w.on("failed", (job, err) => {
    if (err instanceof LockBusyError) return; // expected under contention; retried with backoff
    log(name, `job ${job?.name ?? "?"} failed (attempt ${job?.attemptsMade ?? 0})`, { error: err.message });
  });
  w.on("error", (err) => log(name, "worker error", { error: err.message }));
  return w;
}

const workers = [
  start(QUEUE.ingest, ingestProcessor, 10),
  start(QUEUE.dispatch, dispatchProcessor, 5),
  start(QUEUE.reconcile, reconcileProcessor, 20, { max: 40, duration: 1000 }),
  start(QUEUE.approval, approvalProcessor, 5),
  start(QUEUE.sync, syncProcessor, 3),
  start(QUEUE.poller, pollerProcessor, 1),
  start(QUEUE.maintenance, maintenanceProcessor, 2),
];

// Schedulers create at most one job per interval across all worker replicas.
await queue(QUEUE.poller).upsertJobScheduler("poll-active-runs", { every: 60_000 }, { name: "tick", data: {} });
await queue(QUEUE.maintenance).upsertJobScheduler("housekeeping", { every: 5 * 60_000 }, { name: "housekeeping", data: { kind: "housekeeping" } });
await queue(QUEUE.sync).upsertJobScheduler("full-sync", { every: 6 * 3600_000 }, { name: "all", data: { kind: "all" } });

log("worker", `started ${workers.length} workers`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("worker", `${signal} received, finishing current jobs`);
  await Promise.allSettled(workers.map((w) => w.close()));
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

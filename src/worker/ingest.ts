import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { githubCredentials, repositories, webhookInbox, workflowRuns } from "@/server/db/schema";
import { enqueue, type IngestJob } from "@/server/queues";
import { log } from "./context";

type Payload = Record<string, any>;

/** Turns a stored webhook into resource keys for the controllers. Never calls GitHub. */
export async function ingestProcessor(job: Job<IngestJob>) {
  const [row] = await db.select().from(webhookInbox).where(eq(webhookInbox.deliveryId, job.data.deliveryId));
  if (!row || row.processedAt) return;
  const p = row.payload as Payload;

  try {
    switch (row.event) {
      case "workflow_run":
        await onRun(p.repository, p.workflow_run?.id, false);
        break;
      case "workflow_job":
        await onRun(p.repository, p.workflow_job?.run_id, p.action === "waiting");
        break;
      case "deployment_review":
      case "deployment_status":
        if (p.workflow_run?.id) await onRun(p.repository, p.workflow_run.id, true);
        break;
      case "push": {
        const touched = (p.commits ?? []).some((c: Payload) =>
          [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f: string) => f.startsWith(".github/workflows/") || f.startsWith(".github/flowdeck/")),
        );
        const isDefault = p.ref === `refs/heads/${p.repository?.default_branch}`;
        if (touched && isDefault) await syncRepoByGithubId(p.repository?.id);
        break;
      }
      case "repository":
        await syncRepoByGithubId(p.repository?.id);
        break;
      case "installation":
      case "installation_repositories": {
        const login = p.installation?.account?.login;
        if (login) {
          const creds = await db
            .select({ id: githubCredentials.id })
            .from(githubCredentials)
            .where(and(sql`lower(${githubCredentials.owner}) = lower(${login})`, eq(githubCredentials.purpose, "dispatch")));
          for (const c of creds) await enqueue.syncOwner(c.id);
        }
        break;
      }
      default:
        break;
    }
    await db.update(webhookInbox).set({ processedAt: new Date(), error: null }).where(eq(webhookInbox.deliveryId, row.deliveryId));
  } catch (e) {
    await db.update(webhookInbox).set({ error: e instanceof Error ? e.message : String(e) }).where(eq(webhookInbox.deliveryId, row.deliveryId));
    throw e;
  }
}

async function findRepo(githubId: number | undefined) {
  if (!githubId) return null;
  const [repo] = await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.githubId, githubId));
  return repo ?? null;
}

async function onRun(repository: Payload | undefined, githubRunId: number | undefined, approvals: boolean) {
  if (!githubRunId) return;
  const repo = await findRepo(repository?.id);
  if (!repo) {
    log("ingest", "event for a repository FlowDeck doesn't know yet; sync your connections", { repo: repository?.full_name });
    return;
  }
  await db.update(workflowRuns).set({ lastWebhookAt: new Date() }).where(eq(workflowRuns.githubRunId, githubRunId));
  await enqueue.reconcile(repo.id, githubRunId);
  if (approvals) await enqueue.approvalRefresh(repo.id, githubRunId, 1_000);
}

async function syncRepoByGithubId(githubId: number | undefined) {
  const repo = await findRepo(githubId);
  if (repo) await enqueue.syncRepo(repo.id);
}

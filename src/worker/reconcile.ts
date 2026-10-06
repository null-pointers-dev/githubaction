import type { Job } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { approvalRequests, repositories, runRequests, workflowJobs, workflowRuns, workflows, type JobStep } from "@/server/db/schema";
import { clientFor, gh, isGitHubError } from "@/server/github/client";
import { withLock } from "@/server/lock";
import { enqueue, type ReconcileJob } from "@/server/queues";
import { publish } from "@/server/pubsub";
import { isTerminal, phaseFromGitHub, rank } from "@/lib/phases";
import { log } from "./context";

type GhRun = {
  id: number;
  workflow_id: number;
  run_number: number;
  run_attempt?: number;
  display_title?: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  run_started_at?: string | null;
  created_at: string;
  updated_at: string;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
};

type GhJob = {
  id: number;
  run_attempt?: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  runner_name: string | null;
  labels: string[];
  steps?: Array<{ number: number; name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }>;
};

const date = (v: string | null | undefined) => (v ? new Date(v) : null);

/**
 * Level-triggered reconcile: reads the run from GitHub, merges it into our record
 * without ever moving backwards, and links it to a RunRequest.
 * Woken by webhooks, by the 60-second poller and after every action.
 */
export async function reconcileProcessor(job: Job<ReconcileJob>) {
  const { repositoryId, githubRunId } = job.data;
  await withLock(`fd:lock:run:${githubRunId}`, 60_000, () => reconcile(repositoryId, githubRunId));
}

async function reconcile(repositoryId: string, githubRunId: number) {
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId));
  if (!repo) return;
  const [cur] = await db.select().from(workflowRuns).where(eq(workflowRuns.githubRunId, githubRunId));
  const { octokit } = await clientFor(repo.owner, "dispatch");
  const now = new Date();

  let data: GhRun;
  let etag: string | null = null;
  try {
    const res = await gh<GhRun>(octokit, "GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
      owner: repo.owner,
      repo: repo.name,
      run_id: githubRunId,
      headers: cur?.etag ? { "if-none-match": cur.etag } : {},
    });
    data = res.data;
    etag = res.headers.etag ?? null;
  } catch (e) {
    if (isGitHubError(e) && e.status === 304) {
      // Run unchanged (free: 304s don't count against the rate limit). Jobs can still move.
      if (cur) {
        await db.update(workflowRuns).set({ lastSyncedAt: now, notFoundCount: 0 }).where(eq(workflowRuns.id, cur.id));
        if (!isTerminal(cur.phase)) await syncJobs(octokit, repo, cur.id, githubRunId, cur.runAttempt, cur.jobsEtag, cur.runRequestId);
      }
      return;
    }
    if (isGitHubError(e) && e.status === 404) {
      if (!cur) return;
      const misses = cur.notFoundCount + 1;
      await db.update(workflowRuns).set({ notFoundCount: misses, lastSyncedAt: now, ...(misses >= 3 ? { phase: "lost" } : {}) }).where(eq(workflowRuns.id, cur.id));
      if (misses >= 3 && cur.runRequestId) {
        await db.update(runRequests).set({ phase: "lost", updatedAt: now }).where(eq(runRequests.id, cur.runRequestId));
        await publish(`run-${cur.runRequestId}`, { phase: "lost" });
      }
      return;
    }
    throw e;
  }

  const attempt = data.run_attempt ?? 1;
  const incoming = phaseFromGitHub(data.status, data.conclusion);

  // Never regress: ignore stale attempts and lower-ranked observations of the same attempt.
  if (cur && attempt < cur.runAttempt) {
    log("reconcile", "ignored stale attempt", { githubRunId, attempt, current: cur.runAttempt });
    return;
  }
  const sameAttempt = cur && attempt === cur.runAttempt;
  const phase = !cur || !sameAttempt || rank(incoming) >= rank(cur.phase) || cur.phase === "lost" ? incoming : cur.phase;

  const [wf] = await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.githubWorkflowId, data.workflow_id));
  const values = {
    repositoryId: repo.id,
    workflowId: wf?.id ?? null,
    githubRunId,
    runAttempt: attempt,
    runNumber: data.run_number,
    displayTitle: data.display_title ?? null,
    event: data.event,
    status: data.status,
    conclusion: data.conclusion,
    phase,
    headBranch: data.head_branch,
    headSha: data.head_sha,
    actorLogin: data.triggering_actor?.login ?? data.actor?.login ?? null,
    htmlUrl: data.html_url,
    etag,
    notFoundCount: 0,
    startedAt: date(data.run_started_at) ?? date(data.created_at),
    completedAt: data.status === "completed" ? date(data.updated_at) : null,
    githubUpdatedAt: date(data.updated_at),
    lastSyncedAt: now,
    updatedAt: now,
  };

  const [saved] = await db
    .insert(workflowRuns)
    .values(values)
    .onConflictDoUpdate({
      target: workflowRuns.githubRunId,
      set: { ...values, jobsEtag: sameAttempt ? undefined : null, resourceVersion: sql`${workflowRuns.resourceVersion} + 1` },
    })
    .returning();

  // Link to a RunRequest; runs started outside FlowDeck get an "observed" request so they show up too.
  let runRequestId = saved.runRequestId;
  if (!runRequestId) {
    const [byRun] = await db.select({ id: runRequests.id }).from(runRequests).where(eq(runRequests.githubRunId, githubRunId));
    if (byRun) runRequestId = byRun.id;
    else if (wf) {
      const [created] = await db
        .insert(runRequests)
        .values({
          workflowId: wf.id,
          source: "github",
          ref: data.head_branch ?? "",
          inputs: {},
          phase,
          githubRunId,
          htmlUrl: data.html_url,
          actorLogin: values.actorLogin,
          createdAt: date(data.created_at) ?? now,
        })
        .returning({ id: runRequests.id });
      runRequestId = created.id;
    }
    if (runRequestId) await db.update(workflowRuns).set({ runRequestId }).where(eq(workflowRuns.id, saved.id));
  }

  if (runRequestId) {
    await db
      .update(runRequests)
      .set({
        phase,
        htmlUrl: data.html_url,
        actorLogin: values.actorLogin,
        updatedAt: now,
        resourceVersion: sql`${runRequests.resourceVersion} + 1`,
        ...(sameAttempt ? {} : { error: null }),
      })
      .where(eq(runRequests.id, runRequestId));
  }

  await syncJobs(octokit, repo, saved.id, githubRunId, attempt, sameAttempt ? cur?.jobsEtag ?? null : null, runRequestId);

  // Approval gates: refresh while waiting, and once more when the run leaves "waiting" to close them.
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)`.mapWith(Number) })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.githubRunId, githubRunId), inArray(approvalRequests.state, ["pending", "deciding"])));
  if (phase === "waiting" || open > 0) await enqueue.approvalRefresh(repo.id, githubRunId);

  if (runRequestId) await publish(`run-${runRequestId}`, { phase });
  if (!cur || cur.phase !== phase) await publish("runs", { id: runRequestId });
}

async function syncJobs(
  octokit: Awaited<ReturnType<typeof clientFor>>["octokit"],
  repo: { owner: string; name: string },
  workflowRunId: string,
  githubRunId: number,
  attempt: number,
  jobsEtag: string | null,
  runRequestId: string | null,
) {
  let jobs: GhJob[];
  let etag: string | null = null;
  try {
    const res = await gh<{ total_count: number; jobs: GhJob[] }>(octokit, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs", {
      owner: repo.owner,
      repo: repo.name,
      run_id: githubRunId,
      attempt_number: attempt,
      per_page: 100,
      headers: jobsEtag ? { "if-none-match": jobsEtag } : {},
    });
    jobs = res.data.jobs;
    etag = res.headers.etag ?? null;
    if (res.data.total_count > jobs.length) {
      // Large matrices: fetch every page (no ETag across pages).
      jobs = (await octokit.paginate("GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs" as string, {
        owner: repo.owner,
        repo: repo.name,
        run_id: githubRunId,
        attempt_number: attempt,
        per_page: 100,
      })) as GhJob[];
    }
  } catch (e) {
    if (isGitHubError(e) && e.status === 304) return;
    throw e;
  }

  const now = new Date();
  for (const j of jobs) {
    const steps: JobStep[] = (j.steps ?? []).map((s) => ({
      number: s.number,
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      startedAt: s.started_at ?? null,
      completedAt: s.completed_at ?? null,
    }));
    const values = {
      workflowRunId,
      githubJobId: j.id,
      runAttempt: j.run_attempt ?? attempt,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      runnerName: j.runner_name,
      labels: j.labels ?? [],
      steps,
      htmlUrl: j.html_url,
      startedAt: date(j.started_at),
      completedAt: date(j.completed_at),
      updatedAt: now,
    };
    await db.insert(workflowJobs).values(values).onConflictDoUpdate({ target: workflowJobs.githubJobId, set: values });
  }
  await db.update(workflowRuns).set({ jobsEtag: etag }).where(eq(workflowRuns.id, workflowRunId));
  if (runRequestId) await publish(`run-${runRequestId}`, { jobs: jobs.length });
}

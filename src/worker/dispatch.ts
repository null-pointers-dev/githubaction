import type { Job } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { db } from "@/server/db";
import { runRequests, workflowRuns } from "@/server/db/schema";
import { clientFor, gh, githubMessage, isGitHubError } from "@/server/github/client";
import { parseWorkflow } from "@/server/github/parse-workflow";
import { validateInputs } from "@/lib/inputs";
import { enqueue, type DispatchJob } from "@/server/queues";
import { publish } from "@/server/pubsub";
import { audit } from "@/server/audit";
import { isTerminal } from "@/lib/phases";
import { loadRunRequest, log } from "./context";

const MAX_DISPATCH_ATTEMPTS = 2;
const RESOLVE_TRIES = 8; // about 2 minutes of looking for the run

export async function dispatchProcessor(job: Job<DispatchJob>) {
  const data = job.data;
  if (data.kind === "dispatch") return dispatchRun(data.runRequestId);
  if (data.kind === "resolve") return resolveUnknown(data.runRequestId, data.tries ?? 0);
  if (data.kind === "action") return runAction(data.runRequestId, data.action, data.userId);
}

async function setPhase(id: string, phase: string, extra: Partial<typeof runRequests.$inferInsert> = {}) {
  await db
    .update(runRequests)
    .set({ ...extra, phase, updatedAt: new Date(), resourceVersion: sql`${runRequests.resourceVersion} + 1` })
    .where(eq(runRequests.id, id));
  await publish(`run-${id}`, { phase });
  await publish("runs", { id });
}

async function dispatchRun(id: string) {
  const ctx = await loadRunRequest(id);
  if (!ctx) return;
  if (ctx.rr.phase === "dispatching") return resolveUnknown(id, 0); // a previous attempt crashed mid-call
  if (ctx.rr.phase !== "pending") return;

  // Claim: only one worker can move pending -> dispatching.
  const claimed = await db
    .update(runRequests)
    .set({
      phase: "dispatching",
      dispatchAttempts: sql`${runRequests.dispatchAttempts} + 1`,
      dispatchStartedAt: new Date(),
      updatedAt: new Date(),
      resourceVersion: sql`${runRequests.resourceVersion} + 1`,
    })
    .where(and(eq(runRequests.id, id), eq(runRequests.phase, "pending")))
    .returning({ id: runRequests.id });
  if (!claimed.length) return;
  await publish(`run-${id}`, { phase: "dispatching" });

  const { wf, repo, rr } = ctx;
  let octokit;
  try {
    ({ octokit } = await clientFor(repo.owner, "dispatch"));
  } catch (e) {
    return setPhase(id, "dispatch_failed", { error: githubMessage(e) });
  }

  // When dispatching a ref other than the default branch, validate against that ref's workflow file.
  if (rr.ref !== repo.defaultBranch) {
    try {
      const file = await gh(octokit, "GET /repos/{owner}/{repo}/contents/{path}", { owner: repo.owner, repo: repo.name, path: wf.path, ref: rr.ref });
      const parsed = parseWorkflow(Buffer.from(file.data.content ?? "", "base64").toString("utf8"));
      if (!parsed.dispatchable) return setPhase(id, "dispatch_failed", { error: `On ${rr.ref}, this workflow can't be started manually.` });
      const check = validateInputs(parsed.inputs, rr.inputs);
      if (!check.ok) {
        const msg = Object.values(check.errors).join(" ");
        return setPhase(id, "dispatch_failed", { error: `The inputs don't match the workflow on ${rr.ref}: ${msg}` });
      }
    } catch (e) {
      if (isGitHubError(e) && e.status === 404) return setPhase(id, "dispatch_failed", { error: `The workflow file doesn't exist on ${rr.ref}.` });
      throw e;
    }
  }

  const params = { owner: repo.owner, repo: repo.name, workflow_id: wf.githubWorkflowId, ref: rr.ref, inputs: rr.inputs };
  try {
    let runId: number | null = null;
    let htmlUrl: string | null = null;
    try {
      const res = await gh<{ workflow_run_id?: number; html_url?: string }>(
        octokit,
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        { ...params, return_run_details: true },
      );
      runId = res.data?.workflow_run_id ?? null;
      htmlUrl = res.data?.html_url ?? null;
    } catch (e) {
      // GitHub Enterprise Server before 3.21 doesn't know return_run_details.
      if (isGitHubError(e) && e.status === 422 && /return_run_details/i.test(githubMessage(e))) {
        await gh(octokit, "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", params);
      } else throw e;
    }

    if (runId) {
      await adoptRun(id, repo.id, wf.id, runId, htmlUrl);
      log("dispatch", "dispatched", { id, runId });
      await enqueue.reconcile(repo.id, runId);
    } else {
      await setPhase(id, "unknown");
      await enqueue.resolve(id, 0, 5_000);
    }
  } catch (e) {
    if (isGitHubError(e) && e.status >= 400 && e.status < 500 && e.status !== 429) {
      log("dispatch", "rejected by GitHub", { id, status: e.status });
      return setPhase(id, "dispatch_failed", { error: githubMessage(e) });
    }
    // Timeout, 5xx or network error: GitHub may or may not have created the run.
    log("dispatch", "outcome unknown", { id, error: githubMessage(e) });
    await setPhase(id, "unknown", { error: null });
    await enqueue.resolve(id, 0, 10_000);
  }
}

/** Links a GitHub run to this request, replacing any placeholder created by a fast webhook. */
async function adoptRun(runRequestId: string, repositoryId: string, workflowId: string, githubRunId: number, htmlUrl: string | null) {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(workflowRuns).where(eq(workflowRuns.githubRunId, githubRunId));
    if (existing?.runRequestId && existing.runRequestId !== runRequestId) {
      // The reconcile loop saw this run first and created an "observed" request for it. Remove it.
      await tx.delete(runRequests).where(and(eq(runRequests.id, existing.runRequestId), eq(runRequests.source, "github")));
    }
    if (existing) {
      await tx.update(workflowRuns).set({ runRequestId, updatedAt: new Date() }).where(eq(workflowRuns.id, existing.id));
    } else {
      await tx.insert(workflowRuns).values({ runRequestId, repositoryId, workflowId, githubRunId, htmlUrl, phase: "queued" });
    }
    await tx
      .update(runRequests)
      .set({
        phase: existing && existing.phase !== "queued" ? existing.phase : "dispatched",
        githubRunId,
        htmlUrl,
        error: null,
        updatedAt: new Date(),
        resourceVersion: sql`${runRequests.resourceVersion} + 1`,
      })
      .where(eq(runRequests.id, runRequestId));
  });
  await publish(`run-${runRequestId}`, { phase: "dispatched" });
  await publish("runs", { id: runRequestId });
}

/** The dispatch outcome is unknown: look for the run on GitHub before ever retrying. */
async function resolveUnknown(id: string, tries: number) {
  const ctx = await loadRunRequest(id);
  if (!ctx || !["unknown", "dispatching"].includes(ctx.rr.phase)) return;
  const { rr, repo, wf } = ctx;
  const { octokit, credential } = await clientFor(repo.owner, "dispatch");

  const since = new Date((rr.dispatchStartedAt ?? rr.createdAt).getTime() - 60_000).toISOString();
  const res = await gh<{ workflow_runs: Array<{ id: number; html_url: string; created_at: string; actor?: { login: string } }> }>(
    octokit,
    "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
    {
      owner: repo.owner,
      repo: repo.name,
      workflow_id: wf.githubWorkflowId,
      event: "workflow_dispatch",
      branch: rr.ref,
      created: `>=${since}`,
      per_page: 30,
      ...(credential.tokenLogin ? { actor: credential.tokenLogin } : {}),
    },
  );
  const candidates = res.data.workflow_runs ?? [];
  const ids = candidates.map((r) => r.id);
  const linked = ids.length
    ? await db.select({ githubRunId: runRequests.githubRunId }).from(runRequests).where(and(inArray(runRequests.githubRunId, ids), eq(runRequests.source, "flowdeck")))
    : [];
  const taken = new Set(linked.map((l) => l.githubRunId));
  const free = candidates.filter((c) => !taken.has(c.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (free.length > 0) {
    const pick = free[0];
    log("dispatch", "adopted run after unknown outcome", { id, runId: pick.id, candidates: free.length });
    await adoptRun(id, repo.id, wf.id, pick.id, pick.html_url);
    await enqueue.reconcile(repo.id, pick.id);
    return;
  }

  if (tries + 1 < RESOLVE_TRIES) {
    await enqueue.resolve(id, tries + 1, 15_000);
    return;
  }

  if (rr.dispatchAttempts < MAX_DISPATCH_ATTEMPTS) {
    log("dispatch", "no run found, retrying dispatch once", { id });
    await setPhase(id, "pending");
    await enqueue.dispatch(id);
  } else {
    await setPhase(id, "dispatch_failed", { error: "GitHub didn't confirm that the run started. Check GitHub, then run it again if needed." });
  }
}

async function runAction(id: string, action: "cancel" | "rerun" | "rerun_failed" | "rerun_debug", userId: string) {
  const ctx = await loadRunRequest(id);
  if (!ctx?.run) return;
  const { repo, run } = ctx;
  const { octokit } = await clientFor(repo.owner, "dispatch");
  const base = { owner: repo.owner, repo: repo.name, run_id: run.githubRunId };
  try {
    if (action === "cancel") {
      if (isTerminal(run.phase)) return;
      await gh(octokit, "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel", base);
    } else if (action === "rerun_failed") {
      await gh(octokit, "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs", base);
    } else {
      await gh(octokit, "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun", { ...base, enable_debug_logging: action === "rerun_debug" });
    }
    await audit({ actorUserId: userId, action: `run.${action}.sent`, resourceType: "run", resourceId: id, data: { githubRunId: run.githubRunId } });
    await db.update(runRequests).set({ error: null, updatedAt: new Date() }).where(eq(runRequests.id, id));
  } catch (e) {
    if (isGitHubError(e) && e.status >= 400 && e.status < 500) {
      await audit({ actorUserId: userId, action: `run.${action}.rejected`, resourceType: "run", resourceId: id, data: { error: githubMessage(e) } });
      await db.update(runRequests).set({ error: githubMessage(e), updatedAt: new Date() }).where(eq(runRequests.id, id));
      await publish(`run-${id}`, { error: true });
      return;
    }
    throw e;
  }
  await enqueue.reconcile(repo.id, run.githubRunId, 2_000);
}

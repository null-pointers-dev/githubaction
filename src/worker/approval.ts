import type { Job } from "bullmq";
import { and, eq, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/server/db";
import {
  approvalRequests,
  githubTeamMembers,
  repositories,
  user as users,
  workflowRuns,
  type Reviewer,
} from "@/server/db/schema";
import { clientFor, getCredential, gh, ghPaginate, githubMessage, isGitHubError, octokitFor } from "@/server/github/client";
import { enqueue, type ApprovalJob } from "@/server/queues";
import { publish } from "@/server/pubsub";
import { audit } from "@/server/audit";
import { log } from "./context";

type PendingDeployment = {
  environment: { id: number; name: string };
  wait_timer?: number;
  current_user_can_approve?: boolean;
  reviewers?: Array<{ type: "User" | "Team"; reviewer: { login?: string; slug?: string; name?: string } }>;
};

export async function approvalProcessor(job: Job<ApprovalJob>) {
  const d = job.data;
  if (d.kind === "refresh") return refresh(d.repositoryId, d.githubRunId);
  if (d.kind === "decide") return decide(d.approvalRequestId);
  if (d.kind === "team") return syncTeam(d.org, d.slug);
}

/** Mirrors GitHub's pending deployment gates for a run into approval_requests. */
async function refresh(repositoryId: string, githubRunId: number) {
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.githubRunId, githubRunId));
  if (!repo || !run) return;

  // Read with the approver token when there is one: GitHub then reports whether that account can approve.
  const approver = await getCredential(repo.owner, "approver");
  const octokit = approver ? octokitFor(approver) : (await clientFor(repo.owner, "dispatch")).octokit;

  let pending: PendingDeployment[] = [];
  try {
    const res = await gh<PendingDeployment[]>(octokit, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments", {
      owner: repo.owner,
      repo: repo.name,
      run_id: githubRunId,
    });
    pending = res.data ?? [];
  } catch (e) {
    if (isGitHubError(e) && e.status === 404) pending = [];
    else throw e;
  }

  const now = new Date();
  const seen: number[] = [];
  for (const p of pending) {
    seen.push(p.environment.id);
    const reviewers: Reviewer[] = (p.reviewers ?? [])
      .map((r): Reviewer | null =>
        r.type === "Team" && r.reviewer.slug
          ? { type: "Team", slug: r.reviewer.slug, name: r.reviewer.name, org: repo.owner }
          : r.type === "User" && r.reviewer.login
            ? { type: "User", login: r.reviewer.login }
            : null,
      )
      .filter((r): r is Reviewer => r !== null);

    await db
      .insert(approvalRequests)
      .values({
        workflowRunId: run.id,
        githubRunId,
        runAttempt: run.runAttempt,
        environmentId: p.environment.id,
        environmentName: p.environment.name,
        reviewers,
        approverTokenCanApprove: approver ? (p.current_user_can_approve ?? null) : null,
        waitTimerMinutes: p.wait_timer ?? null,
        state: "pending",
        githubSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [approvalRequests.githubRunId, approvalRequests.runAttempt, approvalRequests.environmentId],
        set: {
          environmentName: p.environment.name,
          reviewers,
          approverTokenCanApprove: approver ? (p.current_user_can_approve ?? null) : null,
          waitTimerMinutes: p.wait_timer ?? null,
          githubSyncedAt: now,
          updatedAt: now,
        },
      });

    for (const r of reviewers) if (r.type === "Team") await enqueue.teamSync(r.org, r.slug);
  }

  // Gates from earlier attempts are superseded by the rerun.
  await db
    .update(approvalRequests)
    .set({ state: "closed", updatedAt: now })
    .where(and(eq(approvalRequests.githubRunId, githubRunId), eq(approvalRequests.state, "pending"), lt(approvalRequests.runAttempt, run.runAttempt)));

  // Gates GitHub no longer reports were settled elsewhere (on GitHub, by a timer, or the run ended).
  const closed = await db
    .update(approvalRequests)
    .set({ state: "closed", updatedAt: now, githubSyncedAt: now })
    .where(
      and(
        eq(approvalRequests.githubRunId, githubRunId),
        eq(approvalRequests.state, "pending"),
        seen.length ? notInArray(approvalRequests.environmentId, seen) : sql`true`,
      ),
    )
    .returning({ id: approvalRequests.id });

  if (pending.length || closed.length) {
    await publish("approvals", { githubRunId });
    if (run.runRequestId) await publish(`run-${run.runRequestId}`, { approvals: pending.length });
  }
}

/** Sends a decision made in FlowDeck to GitHub using the approver account's token. */
async function decide(approvalRequestId: string) {
  const [row] = await db
    .select({ a: approvalRequests, run: workflowRuns, repo: repositories, decider: users })
    .from(approvalRequests)
    .innerJoin(workflowRuns, eq(approvalRequests.workflowRunId, workflowRuns.id))
    .innerJoin(repositories, eq(workflowRuns.repositoryId, repositories.id))
    .leftJoin(users, eq(approvalRequests.decidedBy, users.id))
    .where(eq(approvalRequests.id, approvalRequestId));
  if (!row || row.a.state !== "deciding" || !row.a.decision) return;
  const { a, run, repo, decider } = row;

  const revert = async (message: string) => {
    await db
      .update(approvalRequests)
      .set({ state: "pending", decision: null, decidedBy: null, decidedAt: null, error: message, updatedAt: new Date() })
      .where(and(eq(approvalRequests.id, a.id), eq(approvalRequests.state, "deciding")));
    await audit({ actorUserId: a.decidedBy, action: "approval.failed", resourceType: "approval", resourceId: a.id, data: { error: message } });
    await publish("approvals", { id: a.id });
    if (run.runRequestId) await publish(`run-${run.runRequestId}`, { approval: a.id });
  };

  const approver = await getCredential(repo.owner, "approver");
  if (!approver) return revert(`No approver token is set up for ${repo.owner}. An admin can add one under Settings, Connections.`);

  const verb = a.decision === "approve" ? "Approved" : "Rejected";
  const who = decider ? `${decider.name} <${decider.email}>` : "a FlowDeck user";
  const comment = `${verb} by ${who} in FlowDeck${a.comment ? `: ${a.comment}` : "."}`.slice(0, 1000);

  try {
    await gh(octokitFor(approver), "POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments", {
      owner: repo.owner,
      repo: repo.name,
      run_id: run.githubRunId,
      environment_ids: [a.environmentId],
      state: a.decision === "approve" ? "approved" : "rejected",
      comment,
    });
  } catch (e) {
    if (isGitHubError(e) && e.status >= 400 && e.status < 500 && e.status !== 429) {
      const hint =
        e.status === 422 || e.status === 403
          ? ` Check that ${approver.tokenLogin ? `@${approver.tokenLogin}` : "the approver account"} is a required reviewer for "${a.environmentName}" and isn't the account that started the run.`
          : "";
      return revert(`${githubMessage(e)}.${hint}`);
    }
    throw e; // transient: BullMQ retries; the request stays "deciding"
  }

  const now = new Date();
  await db
    .update(approvalRequests)
    .set({ state: a.decision === "approve" ? "approved" : "rejected", decidedAt: now, error: null, updatedAt: now, githubSyncedAt: now })
    .where(eq(approvalRequests.id, a.id));
  await audit({
    actorUserId: a.decidedBy,
    action: a.decision === "approve" ? "approval.approved" : "approval.rejected",
    resourceType: "approval",
    resourceId: a.id,
    data: { environment: a.environmentName, githubRunId: run.githubRunId, via: approver.tokenLogin, comment: a.comment },
  });
  log("approval", `${verb.toLowerCase()} on GitHub`, { approval: a.id, env: a.environmentName });
  await publish("approvals", { id: a.id });
  if (run.runRequestId) await publish(`run-${run.runRequestId}`, { approval: a.id });
  await enqueue.reconcile(repo.id, run.githubRunId, 1_500);
}

/** Caches members of a GitHub team that is listed as an environment reviewer. */
async function syncTeam(org: string, slug: string) {
  const { octokit } = await clientFor(org, "dispatch");
  let members: Array<{ login: string }> = [];
  try {
    members = await ghPaginate(octokit, "GET /orgs/{org}/teams/{team_slug}/members", { org, team_slug: slug });
  } catch (e) {
    log("approval", "couldn't read team members; give the dispatch connection read access to organisation members", {
      org,
      slug,
      error: githubMessage(e),
    });
    return;
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(githubTeamMembers).where(and(eq(githubTeamMembers.org, org), eq(githubTeamMembers.teamSlug, slug)));
    if (members.length) {
      await tx.insert(githubTeamMembers).values(members.map((m) => ({ org, teamSlug: slug, login: m.login, syncedAt: now })));
    }
  });
  await publish("approvals", { team: slug });
}


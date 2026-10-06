import { and, asc, count, desc, eq, gte, ilike, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "./db";
import {
  approvalRequests,
  repositories,
  runRequests,
  user as users,
  workflowJobs,
  workflowRuns,
  workflowVersions,
  workflows,
  type RepoEnvironment,
} from "./db/schema";
import { TERMINAL_PHASES, isTerminal } from "@/lib/phases";
import { maskInputs, type InputField } from "@/lib/inputs";
import type { JobMeta, LiveJob } from "@/lib/graph";
import { resolveEnvironment } from "@/lib/graph";
import { describeReviewers, evaluate, loadPolicyContext, resolvePolicy, type PolicyContext } from "./approvals/policy";
import type { AppUser } from "./session";

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export type CatalogFilter = "all" | "approval" | "failing" | "mine";

function protectedEnvNames(envs: RepoEnvironment[]) {
  return new Set(envs.filter((e) => e.protected).map((e) => e.name.toLowerCase()));
}

/** True when some job targets a protected environment (or one chosen at run time). */
export function mayNeedApproval(jobs: JobMeta[], envs: RepoEnvironment[]): boolean {
  const prot = protectedEnvNames(envs);
  if (prot.size === 0) return false;
  return jobs.some((j) => {
    if (!j.environment) return false;
    if (j.environment.includes("${{")) return true;
    return prot.has(j.environment.toLowerCase());
  });
}

export async function listCatalog(userId: string, opts: { q?: string; filter?: CatalogFilter }) {
  const q = opts.q?.trim();
  const rows = await db
    .select({ wf: workflows, repo: repositories, version: workflowVersions })
    .from(workflows)
    .innerJoin(repositories, eq(workflows.repositoryId, repositories.id))
    .leftJoin(workflowVersions, eq(workflows.currentVersionId, workflowVersions.id))
    .where(
      and(
        eq(workflows.state, "active"),
        eq(workflows.dispatchable, true),
        eq(repositories.archived, false),
        q
          ? or(
              ilike(workflows.name, `%${q}%`),
              ilike(workflows.path, `%${q}%`),
              ilike(repositories.fullName, `%${q}%`),
              ilike(workflows.ownerTeam, `%${q}%`),
            )
          : undefined,
      ),
    )
    .orderBy(asc(workflows.name))
    .limit(500);

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.wf.id);
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [latest, stats, mine] = await Promise.all([
    db
      .selectDistinctOn([runRequests.workflowId], {
        workflowId: runRequests.workflowId,
        id: runRequests.id,
        phase: runRequests.phase,
        createdAt: runRequests.createdAt,
        requester: users.name,
        actorLogin: runRequests.actorLogin,
      })
      .from(runRequests)
      .leftJoin(users, eq(runRequests.requestedBy, users.id))
      .where(inArray(runRequests.workflowId, ids))
      .orderBy(runRequests.workflowId, desc(runRequests.createdAt)),
    db
      .select({
        workflowId: runRequests.workflowId,
        total: count(),
        ok: sql<number>`count(*) filter (where ${runRequests.phase} = 'succeeded')`.mapWith(Number),
      })
      .from(runRequests)
      .where(
        and(
          inArray(runRequests.workflowId, ids),
          gte(runRequests.createdAt, since),
          inArray(runRequests.phase, ["succeeded", "failed", "timed_out", "cancelled"]),
        ),
      )
      .groupBy(runRequests.workflowId),
    db
      .selectDistinct({ workflowId: runRequests.workflowId })
      .from(runRequests)
      .where(and(inArray(runRequests.workflowId, ids), eq(runRequests.requestedBy, userId))),
  ]);

  const latestBy = new Map(latest.map((l) => [l.workflowId, l]));
  const statsBy = new Map(stats.map((s) => [s.workflowId, s]));
  const mineSet = new Set(mine.map((m) => m.workflowId));

  let items = rows.map(({ wf, repo, version }) => {
    const s = statsBy.get(wf.id);
    return {
      id: wf.id,
      name: wf.name,
      path: wf.path,
      repo: repo.fullName,
      ownerTeam: wf.ownerTeam,
      description: wf.description,
      tags: wf.tags,
      gated: mayNeedApproval(version?.jobs ?? [], repo.environments),
      latest: latestBy.get(wf.id) ?? null,
      successRate: s && s.total > 0 ? Math.round((s.ok / s.total) * 100) : null,
      runs30d: s?.total ?? 0,
      usedByMe: mineSet.has(wf.id),
    };
  });

  if (opts.filter === "approval") items = items.filter((i) => i.gated);
  if (opts.filter === "failing") items = items.filter((i) => i.latest && ["failed", "timed_out", "dispatch_failed"].includes(i.latest.phase));
  if (opts.filter === "mine") items = items.filter((i) => i.usedByMe);
  // Most recently run first, never-run last.
  items.sort((a, b) => (b.latest?.createdAt?.getTime() ?? 0) - (a.latest?.createdAt?.getTime() ?? 0) || a.name.localeCompare(b.name));
  return items;
}

/* ------------------------------------------------------------------ */
/* Workflow page                                                       */
/* ------------------------------------------------------------------ */

export async function getWorkflowPage(id: string) {
  const [row] = await db
    .select({ wf: workflows, repo: repositories, version: workflowVersions })
    .from(workflows)
    .innerJoin(repositories, eq(workflows.repositoryId, repositories.id))
    .leftJoin(workflowVersions, eq(workflows.currentVersionId, workflowVersions.id))
    .where(eq(workflows.id, id));
  if (!row) return null;

  const recent = await db
    .select({ id: runRequests.id, phase: runRequests.phase, createdAt: runRequests.createdAt, ref: runRequests.ref, inputs: runRequests.inputs, requester: users.name, actorLogin: runRequests.actorLogin })
    .from(runRequests)
    .leftJoin(users, eq(runRequests.requestedBy, users.id))
    .where(eq(runRequests.workflowId, id))
    .orderBy(desc(runRequests.createdAt))
    .limit(8);

  const [{ active }] = await db
    .select({ active: count() })
    .from(runRequests)
    .where(and(eq(runRequests.workflowId, id), notInArray(runRequests.phase, TERMINAL_PHASES)));

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [stat] = await db
    .select({
      total: count(),
      ok: sql<number>`count(*) filter (where ${runRequests.phase} = 'succeeded')`.mapWith(Number),
      p50: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${workflowRuns.completedAt} - ${workflowRuns.startedAt})))`.mapWith((v) => (v === null ? null : Number(v))),
    })
    .from(runRequests)
    .leftJoin(workflowRuns, eq(workflowRuns.runRequestId, runRequests.id))
    .where(and(eq(runRequests.workflowId, id), gte(runRequests.createdAt, since), inArray(runRequests.phase, ["succeeded", "failed", "timed_out", "cancelled"])));

  const ctx = await loadPolicyContext();
  const environments = row.repo.environments.map((e) => {
    const p = resolvePolicy(ctx, row.repo.id, e.name);
    return {
      name: e.name,
      protected: e.protected,
      mode: p.mode,
      approvers:
        p.mode === "github"
          ? describeReviewers(e.reviewers)
          : [
              ...p.approverRoles.map((r) => `${r}s`),
              ...(p.approverUserIds.length ? [`${p.approverUserIds.length} named people`] : []),
            ].join(", ") || "no approvers set",
    };
  });

  return {
    workflow: row.wf,
    repo: row.repo,
    version: row.version,
    recent,
    activeRuns: active,
    stats: {
      total: stat?.total ?? 0,
      successRate: stat && stat.total > 0 ? Math.round((stat.ok / stat.total) * 100) : null,
      p50Seconds: stat?.p50 ?? null,
    },
    environments,
  };
}

/* ------------------------------------------------------------------ */
/* Runs list                                                           */
/* ------------------------------------------------------------------ */

export type RunsFilter = "all" | "mine" | "active" | "waiting" | "failed";

export async function listRuns(userId: string, filter: RunsFilter) {
  const where =
    filter === "mine"
      ? eq(runRequests.requestedBy, userId)
      : filter === "active"
        ? notInArray(runRequests.phase, TERMINAL_PHASES)
        : filter === "waiting"
          ? eq(runRequests.phase, "waiting")
          : filter === "failed"
            ? inArray(runRequests.phase, ["failed", "timed_out", "dispatch_failed", "lost"])
            : undefined;
  return db
    .select({
      id: runRequests.id,
      phase: runRequests.phase,
      ref: runRequests.ref,
      source: runRequests.source,
      createdAt: runRequests.createdAt,
      updatedAt: runRequests.updatedAt,
      workflowName: workflows.name,
      workflowId: workflows.id,
      repo: repositories.fullName,
      requester: users.name,
      actorLogin: runRequests.actorLogin,
      runNumber: workflowRuns.runNumber,
      runAttempt: workflowRuns.runAttempt,
      startedAt: workflowRuns.startedAt,
      completedAt: workflowRuns.completedAt,
    })
    .from(runRequests)
    .innerJoin(workflows, eq(runRequests.workflowId, workflows.id))
    .innerJoin(repositories, eq(workflows.repositoryId, repositories.id))
    .leftJoin(users, eq(runRequests.requestedBy, users.id))
    .leftJoin(workflowRuns, eq(workflowRuns.runRequestId, runRequests.id))
    .where(where)
    .orderBy(desc(runRequests.createdAt))
    .limit(150);
}

/* ------------------------------------------------------------------ */
/* Run detail                                                          */
/* ------------------------------------------------------------------ */

export async function getRunView(id: string, viewer: AppUser) {
  const [row] = await db
    .select({ rr: runRequests, wf: workflows, repo: repositories, requester: users, run: workflowRuns })
    .from(runRequests)
    .innerJoin(workflows, eq(runRequests.workflowId, workflows.id))
    .innerJoin(repositories, eq(workflows.repositoryId, repositories.id))
    .leftJoin(users, eq(runRequests.requestedBy, users.id))
    .leftJoin(workflowRuns, eq(workflowRuns.runRequestId, runRequests.id))
    .where(eq(runRequests.id, id));
  if (!row) return null;
  const { rr, wf, repo, requester, run } = row;

  const versionId = rr.workflowVersionId ?? wf.currentVersionId;
  const [version] = versionId ? await db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId)) : [];
  const fields: InputField[] = version?.inputs ?? [];

  const jobs = run
    ? await db
        .select()
        .from(workflowJobs)
        .where(and(eq(workflowJobs.workflowRunId, run.id), eq(workflowJobs.runAttempt, run.runAttempt)))
        .orderBy(asc(workflowJobs.startedAt), asc(workflowJobs.name))
    : [];

  const approvalRows = run
    ? await db
        .select({ a: approvalRequests, decider: users.name })
        .from(approvalRequests)
        .leftJoin(users, eq(approvalRequests.decidedBy, users.id))
        .where(and(eq(approvalRequests.workflowRunId, run.id), eq(approvalRequests.runAttempt, run.runAttempt)))
        .orderBy(asc(approvalRequests.createdAt))
    : [];

  const ctx = approvalRows.length ? await loadPolicyContext() : null;
  const approvals = approvalRows.map(({ a, decider }) => {
    const elig = ctx
      ? evaluate(ctx, viewer, {
          repositoryId: repo.id,
          owner: repo.owner,
          environmentName: a.environmentName,
          reviewers: a.reviewers,
          requestedBy: rr.requestedBy,
        })
      : { allowed: false, reason: "", mode: "github" as const };
    return {
      id: a.id,
      environmentName: a.environmentName,
      state: a.state,
      decision: a.decision,
      reviewers: describeReviewers(a.reviewers),
      decidedBy: decider,
      decidedAt: a.decidedAt?.toISOString() ?? null,
      comment: a.comment,
      error: a.error,
      waitTimerMinutes: a.waitTimerMinutes,
      createdAt: a.createdAt.toISOString(),
      canApprove: elig.allowed && a.state === "pending",
      reason: elig.reason,
      mode: elig.mode,
    };
  });

  const liveJobs: LiveJob[] = jobs.map((j) => ({
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    startedAt: j.startedAt?.toISOString() ?? null,
    completedAt: j.completedAt?.toISOString() ?? null,
  }));

  const terminal = isTerminal(rr.phase);
  const isOwnerOrAdmin = viewer.role === "admin" || rr.requestedBy === viewer.id;

  return {
    id: rr.id,
    phase: rr.phase,
    source: rr.source,
    ref: rr.ref,
    inputs: maskInputs(fields, rr.inputs),
    inputLabels: Object.fromEntries(fields.map((f) => [f.key, f.label])),
    error: rr.error,
    createdAt: rr.createdAt.toISOString(),
    requester: requester ? { id: requester.id, name: requester.name, email: requester.email } : null,
    actorLogin: run?.actorLogin ?? rr.actorLogin,
    workflow: { id: wf.id, name: wf.name, path: wf.path },
    repository: { id: repo.id, fullName: repo.fullName },
    run: run
      ? {
          githubRunId: run.githubRunId,
          runNumber: run.runNumber,
          runAttempt: run.runAttempt,
          status: run.status,
          conclusion: run.conclusion,
          headBranch: run.headBranch,
          headSha: run.headSha,
          htmlUrl: run.htmlUrl,
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
          lastSyncedAt: run.lastSyncedAt?.toISOString() ?? null,
          lastWebhookAt: run.lastWebhookAt?.toISOString() ?? null,
        }
      : null,
    htmlUrl: run?.htmlUrl ?? rr.htmlUrl,
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      htmlUrl: j.htmlUrl,
      startedAt: j.startedAt?.toISOString() ?? null,
      completedAt: j.completedAt?.toISOString() ?? null,
      steps: j.steps,
      labels: j.labels,
    })),
    liveJobs,
    graphJobs: version?.jobs ?? [],
    approvals,
    canCancel: !terminal && !!run && isOwnerOrAdmin,
    canRerun: terminal && !!run && isOwnerOrAdmin,
    canRunAgain: rr.source === "flowdeck" || Object.keys(rr.inputs).length > 0,
  };
}

export type RunView = NonNullable<Awaited<ReturnType<typeof getRunView>>>;

/* ------------------------------------------------------------------ */
/* Approvals inbox                                                     */
/* ------------------------------------------------------------------ */

async function pendingGates() {
  return db
    .select({
      a: approvalRequests,
      run: workflowRuns,
      repo: repositories,
      rr: runRequests,
      wf: workflows,
      requester: users.name,
    })
    .from(approvalRequests)
    .innerJoin(workflowRuns, eq(approvalRequests.workflowRunId, workflowRuns.id))
    .innerJoin(repositories, eq(workflowRuns.repositoryId, repositories.id))
    .leftJoin(runRequests, eq(workflowRuns.runRequestId, runRequests.id))
    .leftJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
    .leftJoin(users, eq(runRequests.requestedBy, users.id))
    .where(and(eq(approvalRequests.state, "pending"), eq(approvalRequests.runAttempt, workflowRuns.runAttempt)))
    .orderBy(asc(approvalRequests.createdAt));
}

/** Only gates this user may approve. Everyone else never sees them here. */
export async function listInbox(viewer: AppUser, ctx?: PolicyContext) {
  const rows = await pendingGates();
  if (!rows.length) return [];
  const policy = ctx ?? (await loadPolicyContext());
  return rows
    .map((r) => ({
      row: r,
      elig: evaluate(policy, viewer, {
        repositoryId: r.repo.id,
        owner: r.repo.owner,
        environmentName: r.a.environmentName,
        reviewers: r.a.reviewers,
        requestedBy: r.rr?.requestedBy ?? null,
      }),
    }))
    .filter((x) => x.elig.allowed)
    .map(({ row }) => ({
      id: row.a.id,
      environmentName: row.a.environmentName,
      createdAt: row.a.createdAt,
      error: row.a.error,
      runRequestId: row.rr?.id ?? null,
      runNumber: row.run.runNumber,
      workflowName: row.wf?.name ?? row.run.displayTitle ?? "Workflow run",
      repo: row.repo.fullName,
      requester: row.requester ?? (row.run.actorLogin ? `@${row.run.actorLogin}` : null),
      inputs: row.rr ? row.rr.inputs : {},
      ref: row.rr?.ref ?? row.run.headBranch,
    }));
}

export async function countInbox(viewer: AppUser) {
  return (await listInbox(viewer)).length;
}

export async function recentDecisions(viewer: AppUser) {
  return db
    .select({
      id: approvalRequests.id,
      environmentName: approvalRequests.environmentName,
      decision: approvalRequests.decision,
      state: approvalRequests.state,
      decidedAt: approvalRequests.decidedAt,
      runRequestId: workflowRuns.runRequestId,
      workflowName: workflows.name,
    })
    .from(approvalRequests)
    .innerJoin(workflowRuns, eq(approvalRequests.workflowRunId, workflowRuns.id))
    .leftJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
    .where(eq(approvalRequests.decidedBy, viewer.id))
    .orderBy(desc(approvalRequests.decidedAt))
    .limit(10);
}

/** Environments a run will pass through, for the run form's warnings. */
export function gatedEnvironments(jobs: JobMeta[], envs: RepoEnvironment[], inputs: Record<string, string>) {
  const prot = new Map(envs.filter((e) => e.protected).map((e) => [e.name.toLowerCase(), e.name]));
  const out = new Set<string>();
  for (const j of jobs) {
    const env = resolveEnvironment(j.environment, inputs);
    if (env && prot.has(env.toLowerCase())) out.add(prot.get(env.toLowerCase())!);
  }
  return [...out];
}


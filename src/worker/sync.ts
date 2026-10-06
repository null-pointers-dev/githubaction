import type { Job } from "bullmq";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { db } from "@/server/db";
import { githubCredentials, repositories, workflowVersions, workflows, type RepoEnvironment, type Reviewer } from "@/server/db/schema";
import { clientFor, gh, ghPaginate, githubMessage, isGitHubError, octokitFor } from "@/server/github/client";
import { parseWorkflow } from "@/server/github/parse-workflow";
import { enqueue, type SyncJob } from "@/server/queues";
import { log } from "./context";

type GhRepo = { id: number; name: string; full_name: string; owner: { login: string }; default_branch: string; private: boolean; archived: boolean };

export async function syncProcessor(job: Job<SyncJob>) {
  const d = job.data;
  if (d.kind === "all") {
    const creds = await db.select({ id: githubCredentials.id }).from(githubCredentials).where(eq(githubCredentials.purpose, "dispatch"));
    for (const c of creds) await enqueue.syncOwner(c.id);
    return;
  }
  if (d.kind === "owner") return syncOwner(d.credentialId);
  if (d.kind === "repo") return syncRepo(d.repositoryId);
}

async function syncOwner(credentialId: string) {
  const [cred] = await db.select().from(githubCredentials).where(eq(githubCredentials.id, credentialId));
  if (!cred || cred.purpose !== "dispatch") return;
  const octokit = octokitFor(cred);
  const owner = cred.owner.toLowerCase();

  let repos: GhRepo[];
  if (cred.kind === "app") {
    const res = (await octokit.paginate("GET /installation/repositories" as string, { per_page: 100 })) as GhRepo[];
    repos = res;
  } else {
    try {
      repos = await ghPaginate<GhRepo>(octokit, "GET /orgs/{org}/repos", { org: cred.owner, type: "all" });
    } catch (e) {
      if (!isGitHubError(e) || e.status !== 404) throw e;
      // Not an organisation: the owner is a user account.
      repos = await ghPaginate<GhRepo>(octokit, "GET /user/repos", { affiliation: "owner,collaborator,organization_member" });
    }
  }
  repos = repos.filter((r) => r.owner.login.toLowerCase() === owner);

  const now = new Date();
  for (const r of repos) {
    const [saved] = await db
      .insert(repositories)
      .values({
        githubId: r.id,
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
        archived: r.archived,
      })
      .onConflictDoUpdate({
        target: repositories.githubId,
        set: { owner: r.owner.login, name: r.name, fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, archived: r.archived, updatedAt: now },
      })
      .returning({ id: repositories.id });
    if (!r.archived) await enqueue.syncRepo(saved.id);
  }
  log("sync", `owner ${cred.owner}: ${repos.length} repositories`);
}

async function readEnvironments(octokit: Awaited<ReturnType<typeof clientFor>>["octokit"], owner: string, repo: string): Promise<RepoEnvironment[]> {
  try {
    const res = await gh<{ environments?: Array<{ id: number; name: string; protection_rules?: Array<{ type: string; prevent_self_review?: boolean; reviewers?: Array<{ type: string; reviewer: { login?: string; slug?: string; name?: string } }> }> }> }>(
      octokit,
      "GET /repos/{owner}/{repo}/environments",
      { owner, repo, per_page: 100 },
    );
    return (res.data.environments ?? []).map((e) => {
      const rule = (e.protection_rules ?? []).find((r) => r.type === "required_reviewers");
      const reviewers: Reviewer[] = (rule?.reviewers ?? [])
        .map((r): Reviewer | null =>
          r.type === "Team" && r.reviewer.slug
            ? { type: "Team", slug: r.reviewer.slug, name: r.reviewer.name, org: owner }
            : r.type === "User" && r.reviewer.login
              ? { type: "User", login: r.reviewer.login }
              : null,
        )
        .filter((r): r is Reviewer => r !== null);
      return { id: e.id, name: e.name, protected: !!rule, reviewers, preventSelfReview: !!rule?.prevent_self_review };
    });
  } catch (e) {
    if (isGitHubError(e) && (e.status === 404 || e.status === 403)) return [];
    throw e;
  }
}

async function readFile(octokit: Awaited<ReturnType<typeof clientFor>>["octokit"], owner: string, repo: string, path: string, ref: string) {
  try {
    const res = await gh<{ sha: string; content?: string; encoding?: string }>(octokit, "GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref });
    return { sha: res.data.sha, text: Buffer.from(res.data.content ?? "", "base64").toString("utf8") };
  } catch (e) {
    if (isGitHubError(e) && e.status === 404) return null;
    throw e;
  }
}

async function syncRepo(repositoryId: string) {
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId));
  if (!repo) return;
  const { octokit } = await clientFor(repo.owner, "dispatch");
  const now = new Date();

  let info: GhRepo;
  try {
    info = (await gh<GhRepo>(octokit, "GET /repos/{owner}/{repo}", { owner: repo.owner, repo: repo.name })).data;
  } catch (e) {
    if (isGitHubError(e) && e.status === 404) {
      await db.update(repositories).set({ archived: true, updatedAt: now }).where(eq(repositories.id, repo.id));
      return;
    }
    throw e;
  }
  const environments = await readEnvironments(octokit, repo.owner, repo.name);
  await db
    .update(repositories)
    .set({ defaultBranch: info.default_branch, archived: info.archived, fullName: info.full_name, environments, syncedAt: now, updatedAt: now })
    .where(eq(repositories.id, repo.id));

  type GhWorkflow = { id: number; name: string; path: string; state: string; html_url: string };
  const list = await gh<{ workflows: GhWorkflow[] }>(octokit, "GET /repos/{owner}/{repo}/actions/workflows", { owner: repo.owner, repo: repo.name, per_page: 100 });
  const seen: number[] = [];

  for (const w of list.data.workflows ?? []) {
    if (!w.path.startsWith(".github/workflows/")) continue; // dynamic workflows (Dependabot, Pages, ...)
    seen.push(w.id);
    try {
      const file = await readFile(octokit, repo.owner, repo.name, w.path, info.default_branch);
      if (!file) continue;
      const base = w.path.split("/").pop()!;
      const sidecar = await readFile(octokit, repo.owner, repo.name, `.github/flowdeck/${base}`, info.default_branch);
      const parsed = parseWorkflow(file.text, sidecar?.text);

      const [wfRow] = await db
        .insert(workflows)
        .values({
          repositoryId: repo.id,
          githubWorkflowId: w.id,
          path: w.path,
          name: parsed.name ?? w.name,
          state: w.state,
          dispatchable: parsed.dispatchable,
          description: parsed.catalog.description ?? null,
          ownerTeam: parsed.catalog.owner ?? null,
          tags: parsed.catalog.tags ?? [],
          htmlUrl: w.html_url,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: workflows.githubWorkflowId,
          set: {
            path: w.path,
            name: parsed.name ?? w.name,
            state: w.state,
            dispatchable: parsed.dispatchable,
            description: parsed.catalog.description ?? null,
            ownerTeam: parsed.catalog.owner ?? null,
            tags: parsed.catalog.tags ?? [],
            htmlUrl: w.html_url,
            syncedAt: now,
            updatedAt: now,
          },
        })
        .returning({ id: workflows.id });

      const sidecarSha = sidecar?.sha ?? "";
      const [version] = await db
        .insert(workflowVersions)
        .values({
          workflowId: wfRow.id,
          blobSha: file.sha,
          sidecarSha,
          ref: info.default_branch,
          inputs: parsed.inputs,
          jobs: parsed.jobs,
          concurrency: parsed.concurrency,
          parseError: parsed.error ?? null,
        })
        .onConflictDoUpdate({
          target: [workflowVersions.workflowId, workflowVersions.blobSha, workflowVersions.sidecarSha],
          set: { ref: info.default_branch },
        })
        .returning({ id: workflowVersions.id });

      await db.update(workflows).set({ currentVersionId: version.id }).where(eq(workflows.id, wfRow.id));
    } catch (e) {
      log("sync", `failed to sync ${repo.fullName}/${w.path}`, { error: githubMessage(e) });
    }
  }

  await db
    .update(workflows)
    .set({ state: "deleted", updatedAt: now })
    .where(and(eq(workflows.repositoryId, repo.id), seen.length ? notInArray(workflows.githubWorkflowId, seen) : sql`true`));
  log("sync", `repo ${repo.fullName}: ${seen.length} workflows`);
}

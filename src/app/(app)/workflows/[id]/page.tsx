import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@/server/session";
import { getWorkflowPage } from "@/server/views";
import { db } from "@/server/db";
import { runRequests } from "@/server/db/schema";
import { RunForm } from "@/components/RunForm";
import { PhaseStatus } from "@/components/Status";
import { Diamond, Shield } from "@/components/icons";
import { formatDuration, shortSha, timeAgo } from "@/lib/format";
import type { InputValues } from "@/lib/inputs";

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const { from } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const page = await getWorkflowPage(id);
  if (!page) notFound();
  const { workflow, repo, version, recent, stats, environments } = page;

  // "Run again": prefill from an earlier run of this workflow.
  let initialValues: InputValues | undefined;
  let initialRef: string | undefined;
  if (from && /^[0-9a-f-]{36}$/.test(from)) {
    const [prev] = await db.select().from(runRequests).where(and(eq(runRequests.id, from), eq(runRequests.workflowId, workflow.id)));
    if (prev) {
      initialRef = prev.ref || undefined;
      initialValues = {};
      for (const f of version?.inputs ?? []) {
        const v = prev.inputs[f.key];
        if (v === undefined || f.hidden) continue;
        initialValues[f.key] = f.type === "boolean" ? v === "true" : v;
      }
    }
  }

  const staticGates = [
    ...new Set(
      (version?.jobs ?? []).flatMap((j) =>
        j.environment ? [j.environment.includes("${{") ? "an environment chosen when you run it" : j.environment] : [],
      ),
    ),
  ];

  return (
    <main className="page">
      <div className="crumbs">
        <Link href="/workflows">Workflows</Link>
        <span aria-hidden="true">/</span>
        <span>{workflow.name}</span>
      </div>
      <div className="split">
        <div className="stack">
          <div>
            <h1>{workflow.name}</h1>
            {workflow.description && <p className="lede" style={{ marginTop: 10 }}>{workflow.description}</p>}
          </div>

          <div className="panel panel-body">
            <dl className="facts">
              <div className="fact"><dt>Repository</dt><dd className="mono">{repo.fullName}</dd></div>
              <div className="fact"><dt>Workflow file</dt><dd className="mono">{workflow.path}</dd></div>
              <div className="fact"><dt>Owner</dt><dd>{workflow.ownerTeam ?? "Not set"}</dd></div>
              <div className="fact"><dt>Typical duration</dt><dd>{stats.p50Seconds ? formatDuration(stats.p50Seconds * 1000) : "Not enough runs yet"}</dd></div>
              <div className="fact"><dt>Success, last 30 days</dt><dd>{stats.successRate === null ? "No finished runs" : `${stats.successRate}% of ${stats.total} runs`}</dd></div>
              <div className="fact"><dt>Version</dt><dd className="mono">{version ? shortSha(version.blobSha) : "Not synced"}</dd></div>
            </dl>
          </div>

          {environments.some((e) => e.protected) && (
            <section className="panel" aria-labelledby="gates-title">
              <div className="panel-head"><h2 id="gates-title">Environments that need approval</h2></div>
              <div className="panel-body">
                <ul className="mini-list">
                  {environments.filter((e) => e.protected).map((e) => (
                    <li key={e.name}>
                      <span className="ico ico-wait"><Diamond /></span>
                      <div className="grow">
                        <b>{e.name}</b>
                        <span className="small muted">
                          {e.mode === "github" ? `GitHub reviewers: ${e.approvers}` : `FlowDeck approvers: ${e.approvers}`}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                {staticGates.length > 0 && (
                  <p className="small faint" style={{ marginTop: 12 }}>
                    This workflow's jobs target: {staticGates.join(", ")}.
                  </p>
                )}
              </div>
            </section>
          )}

          <section className="panel" aria-labelledby="recent-title">
            <div className="panel-head"><h2 id="recent-title">Recent runs</h2></div>
            <div className="panel-body">
              {recent.length === 0 ? (
                <p className="muted small">This workflow hasn't run yet.</p>
              ) : (
                <ul className="mini-list">
                  {recent.map((r) => (
                    <li key={r.id}>
                      <PhaseStatus phase={r.phase} label="" />
                      <div className="grow">
                        <Link href={`/runs/${r.id}`}>
                          <b>{r.requester ?? (r.actorLogin ? `@${r.actorLogin}` : "Started on GitHub")}</b>
                        </Link>
                        <span className="small muted">
                          <span className="mono">{r.ref}</span>
                          {Object.keys(r.inputs).length ? `, ${Object.entries(r.inputs).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}
                        </span>
                      </div>
                      <span className="small faint">{timeAgo(r.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        {!workflow.dispatchable || !version ? (
          <section className="panel panel-body">
            <h2>Can't run from FlowDeck</h2>
            <p className="muted" style={{ marginTop: 8 }}>This workflow doesn't have a workflow_dispatch trigger on its default branch.</p>
          </section>
        ) : workflow.state !== "active" ? (
          <section className="panel panel-body">
            <h2>Disabled on GitHub</h2>
            <p className="muted" style={{ marginTop: 8 }}>Enable the workflow on GitHub to run it here.</p>
          </section>
        ) : version.parseError ? (
          <section className="panel panel-body">
            <h2>FlowDeck couldn't read this workflow</h2>
            <p className="callout callout-fail" style={{ marginTop: 12 }}>{version.parseError}</p>
          </section>
        ) : (
          <RunForm
            workflowId={workflow.id}
            versionId={version.id}
            defaultBranch={repo.defaultBranch}
            fields={version.inputs}
            jobs={version.jobs}
            environments={environments}
            activeRuns={page.activeRuns}
            concurrency={version.concurrency ?? null}
            initialValues={initialValues}
            initialRef={initialRef}
            repoFullName={repo.fullName}
            workflowPath={workflow.path}
          />
        )}
      </div>
      <p className="small faint" style={{ marginTop: 20, display: "flex", gap: 6, alignItems: "center" }}>
        <Shield /> Environments marked with a shield pause for approval before their jobs start.
      </p>
    </main>
  );
}

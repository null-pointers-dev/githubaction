"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { RunView as RunViewData } from "@/server/views";
import { isTerminal } from "@/lib/phases";
import { formatDuration, shortSha, timeAgo } from "@/lib/format";
import { PhasePill, Avatar } from "./Status";
import { TransitMap } from "./TransitMap";
import { Check, Diamond, Shield } from "./icons";

function jobIcon(status: string, conclusion: string | null) {
  if (status === "completed") {
    if (conclusion === "success") return <span className="ico ico-ok"><Check /></span>;
    if (conclusion === "skipped" || conclusion === "cancelled" || conclusion === "neutral") return <span className="ico ico-idle">–</span>;
    return <span className="ico ico-fail">!</span>;
  }
  if (status === "waiting") return <span className="ico ico-wait"><Diamond /></span>;
  if (status === "in_progress") return <span className="ico ico-run">•</span>;
  return <span className="ico ico-idle">○</span>;
}

function span(start: string | null, end: string | null) {
  if (!start) return null;
  return (end ? Date.parse(end) : Date.now()) - Date.parse(start);
}

export function RunView({ initial }: { initial: RunViewData }) {
  const [view, setView] = useState(initial);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/v1/runs/${initial.id}`, { cache: "no-store" });
    if (res.ok) setView(await res.json());
  }, [initial.id]);

  useEffect(() => {
    const es = new EventSource(`/api/v1/stream?topics=run-${initial.id}`);
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => {
      if (t) clearTimeout(t);
      t = setTimeout(refresh, 250);
    };
    return () => {
      es.close();
      if (t) clearTimeout(t);
    };
  }, [initial.id, refresh]);

  // Fallback refresh while the run is active, in case the event stream is blocked.
  const terminal = isTerminal(view.phase);
  useEffect(() => {
    if (terminal) return;
    const i = setInterval(refresh, 15_000);
    return () => clearInterval(i);
  }, [terminal, refresh]);

  async function decide(approvalId: string, decision: "approve" | "reject") {
    setBusy(approvalId);
    setNotice(null);
    const res = await fetch(`/api/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, comment: comments[approvalId] || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) setNotice({ tone: "fail", text: body.message ?? "Couldn't record your decision." });
    else setNotice({ tone: "ok", text: decision === "approve" ? "Approved. Sending your approval to GitHub." : "Rejected. Sending your decision to GitHub." });
    refresh();
  }

  async function act(action: "cancel" | "rerun" | "rerun_failed" | "rerun_debug") {
    setBusy(action);
    setNotice(null);
    const res = await fetch(`/api/v1/runs/${view.id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    const label = { cancel: "Cancel requested.", rerun: "Rerun requested.", rerun_failed: "Rerun of failed jobs requested.", rerun_debug: "Rerun with debug logging requested." }[action];
    setNotice(res.ok ? { tone: "ok", text: label } : { tone: "fail", text: body.message ?? "That didn't work." });
    refresh();
  }

  const run = view.run;
  const mine = view.approvals.filter((a) => a.canApprove);
  const others = view.approvals.filter((a) => !a.canApprove && (a.state === "pending" || a.state === "deciding"));
  const decided = view.approvals.filter((a) => a.state === "approved" || a.state === "rejected" || a.state === "closed");
  const deciding = view.approvals.filter((a) => a.state === "deciding");
  const runAgainHref = `/workflows/${view.workflow.id}?from=${view.id}`;

  return (
    <>
      <div className="crumbs">
        <Link href="/workflows">Workflows</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/workflows/${view.workflow.id}`}>{view.workflow.name}</Link>
        <span aria-hidden="true">/</span>
        <span>{run?.runNumber ? `Run ${run.runNumber}` : "New run"}</span>
      </div>

      <div className="run-head">
        <div className="stack" style={{ gap: 14 }}>
          <div className="run-title">
            <h1>{view.workflow.name}</h1>
            {run?.runNumber && <span className="mono">#{run.runNumber}</span>}
            <PhasePill phase={view.phase} />
          </div>
          <div className="row" style={{ gap: 28 }}>
            <div className="who-line">
              <Avatar name={view.requester?.name ?? view.actorLogin} />
              <div>
                {view.requester ? view.requester.name : view.actorLogin ? `@${view.actorLogin}` : "Unknown"}
                <small>
                  {view.source === "flowdeck"
                    ? `Started in FlowDeck${view.actorLogin ? `, sent as @${view.actorLogin}` : ""}`
                    : "Started outside FlowDeck"}
                </small>
              </div>
            </div>
            <div>
              <span className="meta-label">Branch</span>
              <span className="mono">
                {run?.headBranch ?? view.ref}
                {run?.headSha ? ` @ ${shortSha(run.headSha)}` : ""}
              </span>
            </div>
            <div>
              <span className="meta-label">Started</span>
              <span suppressHydrationWarning>
                {run?.startedAt ? `${timeAgo(run.startedAt)}${run.completedAt ? `, took ${formatDuration(span(run.startedAt, run.completedAt))}` : ""}` : timeAgo(view.createdAt)}
              </span>
            </div>
            {run && run.runAttempt > 1 && (
              <div>
                <span className="meta-label">Attempt</span>
                {run.runAttempt}
              </div>
            )}
          </div>
        </div>
        <div className="row">
          {view.htmlUrl && (
            <a className="btn" href={view.htmlUrl} target="_blank" rel="noreferrer">
              View on GitHub
            </a>
          )}
          {view.canRunAgain && (
            <Link className="btn" href={runAgainHref}>
              Run again
            </Link>
          )}
          {view.canRerun && (
            <details className="menu-wrap">
              <summary className="btn">Rerun</summary>
              <div className="menu">
                <button onClick={() => act("rerun")} disabled={!!busy}>
                  Rerun all jobs<span>Starts attempt {(run?.runAttempt ?? 1) + 1} with the same inputs</span>
                </button>
                <button onClick={() => act("rerun_failed")} disabled={!!busy}>
                  Rerun failed jobs<span>Only jobs that failed in this attempt</span>
                </button>
                <button onClick={() => act("rerun_debug")} disabled={!!busy}>
                  Rerun with debug logging<span>Adds runner and step debug output</span>
                </button>
              </div>
            </details>
          )}
          {view.canCancel && (
            <button className="btn btn-danger" onClick={() => act("cancel")} disabled={!!busy}>
              Cancel run
            </button>
          )}
        </div>
      </div>

      {notice && (
        <p className={`callout ${notice.tone === "ok" ? "callout-ok" : "callout-fail"}`} role="status" style={{ marginBottom: 16 }}>
          {notice.text}
        </p>
      )}
      {view.error && (
        <p className="callout callout-fail" style={{ marginBottom: 16 }}>
          {view.phase === "dispatch_failed" ? "GitHub didn't start this run. " : ""}
          {view.error}
        </p>
      )}
      {["pending", "dispatching", "unknown"].includes(view.phase) && (
        <p className="callout callout-info" style={{ marginBottom: 16 }}>
          {view.phase === "unknown"
            ? "GitHub didn't answer in time. FlowDeck is checking whether the run started before trying again, so it never starts twice."
            : "Sending the request to GitHub…"}
        </p>
      )}

      <section className="panel track-panel" aria-labelledby="track-title">
        <div className="panel-head">
          <h2 id="track-title">Progress</h2>
          <div className="track-legend">
            <span className="status s-ok">Done</span>
            <span className="status s-run">Running</span>
            <span className="status s-wait">Waiting</span>
            <span className="status s-idle">Not started</span>
          </div>
        </div>
        <TransitMap meta={view.graphJobs} jobs={view.liveJobs} />
      </section>

      {mine.map((a) => (
        <section className="approval" key={a.id} aria-labelledby={`appr-${a.id}`}>
          <div className="sig" aria-hidden="true">
            <Shield size={20} />
          </div>
          <div>
            <h2 id={`appr-${a.id}`}>{a.environmentName} is waiting for your approval</h2>
            <p className="muted" style={{ marginTop: 4 }} suppressHydrationWarning>
              Requested {timeAgo(a.createdAt)}. {a.reason}
            </p>
            {a.error && (
              <p className="callout callout-fail" style={{ marginTop: 12 }}>
                The last attempt didn't reach GitHub: {a.error}
              </p>
            )}
            <label className="sr-only" htmlFor={`c-${a.id}`}>Comment</label>
            <textarea
              id={`c-${a.id}`}
              className="textarea"
              placeholder="Add a comment for the audit log (optional)"
              value={comments[a.id] ?? ""}
              onChange={(e) => setComments((c) => ({ ...c, [a.id]: e.target.value }))}
            />
            <div className="approval-actions">
              <button className="btn btn-primary" onClick={() => decide(a.id, "approve")} disabled={busy === a.id}>
                {busy === a.id ? "Sending…" : "Approve"}
              </button>
              <button className="btn btn-danger" onClick={() => decide(a.id, "reject")} disabled={busy === a.id}>
                Reject
              </button>
              <span className="faint">Recorded under your name in FlowDeck. GitHub receives the decision from the approver account.</span>
            </div>
          </div>
        </section>
      ))}

      {deciding.map((a) => (
        <div className="gate-note" key={a.id}>
          <span className="ico ico-wait"><Diamond /></span>
          <div>
            <b>{a.decision === "approve" ? "Approved" : "Rejected"} by {a.decidedBy ?? "someone"}</b>
            <p className="small muted">Sending the decision for {a.environmentName} to GitHub…</p>
          </div>
        </div>
      ))}

      {others.filter((a) => a.state === "pending").map((a) => (
        <div className="gate-note" key={a.id}>
          <span className="ico ico-wait"><Diamond /></span>
          <div>
            <b>{a.environmentName} is waiting for approval</b>
            <p className="small muted">
              Reviewers: {a.reviewers}. {a.reason}
            </p>
          </div>
        </div>
      ))}

      <div className="detail-grid">
        <section className="panel jobs" aria-labelledby="jobs-title">
          <div className="panel-head">
            <h2 id="jobs-title">Jobs</h2>
            <span className="small faint">
              {view.jobs.length} {view.jobs.length === 1 ? "job" : "jobs"}, {view.jobs.filter((j) => j.status === "completed").length} finished
            </span>
          </div>
          {view.jobs.length === 0 && <p className="panel-body muted">No jobs yet.</p>}
          {view.jobs.map((j) => (
            <details key={j.id} open={j.status === "in_progress" || (j.status === "completed" && j.conclusion === "failure")}>
              <summary>
                {jobIcon(j.status, j.conclusion)}
                <span className="t">
                  {j.name}
                  {j.labels[0] && <small>{j.labels[0]}</small>}
                </span>
                <span className="small faint num" suppressHydrationWarning>
                  {formatDuration(span(j.startedAt, j.completedAt))} <span className="chev">›</span>
                </span>
              </summary>
              <ul className="steps">
                {j.steps.length === 0 && <li>No steps reported yet.</li>}
                {j.steps.map((s) => (
                  <li key={s.number}>
                    <span style={{ color: s.conclusion === "failure" ? "var(--red)" : undefined }}>
                      {s.status === "in_progress" ? "▸ " : ""}
                      {s.name}
                    </span>
                    <span className="num" suppressHydrationWarning>{formatDuration(span(s.startedAt, s.completedAt))}</span>
                  </li>
                ))}
                {j.htmlUrl && (
                  <li>
                    <a className="link" href={j.htmlUrl} target="_blank" rel="noreferrer">Open logs on GitHub</a>
                    <span />
                  </li>
                )}
              </ul>
            </details>
          ))}
        </section>

        <div className="aside-stack">
          <section className="panel" aria-labelledby="inputs-title">
            <div className="panel-head">
              <h2 id="inputs-title">Inputs</h2>
            </div>
            <div className="panel-body">
              {Object.keys(view.inputs).length === 0 ? (
                <p className="muted small">{view.source === "github" ? "Started outside FlowDeck, so inputs aren't known." : "No inputs."}</p>
              ) : (
                <table className="kv">
                  <tbody>
                    {Object.entries(view.inputs).map(([k, v]) => (
                      <tr key={k}>
                        <td>{view.inputLabels[k] ?? k}</td>
                        <td className="mono">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {decided.length > 0 && (
            <section className="panel" aria-labelledby="decisions-title">
              <div className="panel-head">
                <h2 id="decisions-title">Approvals</h2>
              </div>
              <div className="panel-body">
                <ul className="mini-list">
                  {decided.map((a) => (
                    <li key={a.id}>
                      <span className={`ico ${a.state === "approved" ? "ico-ok" : a.state === "rejected" ? "ico-fail" : "ico-idle"}`}>
                        {a.state === "approved" ? <Check /> : a.state === "rejected" ? "×" : "–"}
                      </span>
                      <div className="grow">
                        <b>{a.environmentName}</b>
                        <span className="small muted" suppressHydrationWarning>
                          {a.state === "closed"
                            ? "Settled on GitHub"
                            : `${a.state === "approved" ? "Approved" : "Rejected"} by ${a.decidedBy ?? "someone"} ${timeAgo(a.decidedAt)}`}
                          {a.comment ? `: “${a.comment}”` : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="panel panel-body">
            <div className="sync-note">
              <span className="live-dot" aria-hidden="true" />
              <div suppressHydrationWarning>
                {run?.lastSyncedAt ? `Checked with GitHub ${timeAgo(run.lastSyncedAt)}.` : "Waiting for GitHub."} Updates arrive live; if one is missed, FlowDeck checks again within a minute.
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

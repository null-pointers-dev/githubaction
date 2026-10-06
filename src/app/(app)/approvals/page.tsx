import Link from "next/link";
import { requireUser } from "@/server/session";
import { listInbox, recentDecisions } from "@/server/views";
import { getApprovalDefaults } from "@/server/settings";
import { ApprovalButtons } from "@/components/ApprovalButtons";
import { LiveRefresh } from "@/components/LiveRefresh";
import { timeAgo } from "@/lib/format";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const user = await requireUser();
  const [items, decisions, defaults] = await Promise.all([listInbox(user), recentDecisions(user), getApprovalDefaults()]);

  return (
    <main className="page">
      <LiveRefresh topics={["approvals"]} />
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted">
            {items.length === 0
              ? "Nothing is waiting for you."
              : `${items.length} ${items.length === 1 ? "deployment is" : "deployments are"} waiting for you. Oldest first.`}
          </p>
        </div>
      </div>

      {defaults.mode === "github" && !user.githubLogin && (
        <p className="callout callout-wait" style={{ marginBottom: 16 }}>
          FlowDeck matches approvers to GitHub's reviewers by GitHub username, and yours isn't linked yet.{" "}
          <Link className="link" href="/account">Link your GitHub account</Link>
        </p>
      )}

      {items.length === 0 ? (
        <div className="panel empty">
          <h3>You're all caught up</h3>
          <p>Deployments you're allowed to approve will appear here. Requests for other approvers don't.</p>
        </div>
      ) : (
        <div className="inbox">
          {items.map((a) => (
            <article className="ask" key={a.id}>
              <div className="ask-body">
                <h3>
                  {a.runRequestId ? <Link href={`/runs/${a.runRequestId}`}>{a.workflowName} to {a.environmentName}</Link> : `${a.workflowName} to ${a.environmentName}`}
                </h3>
                <div className="ask-row">
                  {a.runNumber && <span>Run <b className="mono">#{a.runNumber}</b></span>}
                  {a.requester && <span>Started by <b>{a.requester}</b></span>}
                  <span>Repository <b>{a.repo}</b></span>
                  {a.ref && <span>Branch <b className="mono">{a.ref}</b></span>}
                </div>
                {Object.keys(a.inputs).length > 0 && (
                  <div className="input-chips">
                    {Object.entries(a.inputs).slice(0, 6).map(([k, v]) => (
                      <code key={k}>{k}: {v}</code>
                    ))}
                  </div>
                )}
                {a.error && <p className="error-text" style={{ marginTop: 10 }}>Last attempt failed: {a.error}</p>}
              </div>
              <div className="ask-side">
                <span className="wait-time">Waiting {timeAgo(a.createdAt).replace(" ago", "")}</span>
                <ApprovalButtons id={a.id} />
              </div>
            </article>
          ))}
        </div>
      )}

      {decisions.length > 0 && (
        <section className="panel" style={{ marginTop: 28 }} aria-labelledby="decided-title">
          <div className="panel-head"><h2 id="decided-title">Your recent decisions</h2></div>
          <div className="panel-body">
            <ul className="mini-list">
              {decisions.map((d) => (
                <li key={d.id}>
                  <span className={`ico ${d.decision === "approve" ? "ico-ok" : "ico-fail"}`}>{d.decision === "approve" ? "✓" : "×"}</span>
                  <div className="grow">
                    {d.runRequestId ? <Link href={`/runs/${d.runRequestId}`}><b>{d.workflowName ?? "Run"} to {d.environmentName}</b></Link> : <b>{d.environmentName}</b>}
                    <span className="small muted">
                      {d.decision === "approve" ? "Approved" : "Rejected"}
                      {d.state === "deciding" ? ", sending to GitHub" : ""}
                    </span>
                  </div>
                  <span className="small faint">{timeAgo(d.decidedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}

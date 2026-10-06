import Link from "next/link";
import { requireUser } from "@/server/session";
import { listCatalog, listInbox, type CatalogFilter } from "@/server/views";
import { PhaseStatus } from "@/components/Status";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Diamond, Shield } from "@/components/icons";
import { timeAgo } from "@/lib/format";
import { syncNow } from "../settings/actions";

export const metadata = { title: "Workflows" };

const FILTERS: Array<{ id: CatalogFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "Used by me" },
  { id: "approval", label: "Needs approval" },
  { id: "failing", label: "Failing" },
];

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filter = (FILTERS.find((f) => f.id === sp.filter)?.id ?? "all") as CatalogFilter;
  const [items, inbox] = await Promise.all([listCatalog(user.id, { q: sp.q, filter }), listInbox(user)]);
  const qs = (f: CatalogFilter) => {
    const p = new URLSearchParams();
    if (sp.q) p.set("q", sp.q);
    if (f !== "all") p.set("filter", f);
    const s = p.toString();
    return s ? `/workflows?${s}` : "/workflows";
  };

  return (
    <main className="page">
      <LiveRefresh topics={["runs", "approvals"]} />
      <div className="page-head">
        <div>
          <h1>Workflows</h1>
          <p className="muted">
            {sp.q ? `${items.length} matching “${sp.q}”.` : `${items.length} workflows you can run.`}
          </p>
        </div>
        {user.role === "admin" && (
          <form action={syncNow}>
            <button className="btn">Sync from GitHub</button>
          </form>
        )}
      </div>

      <div className="catalog-grid">
        <div>
          <div className="toolbar">
            <div className="chips" role="group" aria-label="Filter workflows">
              {FILTERS.map((f) => (
                <Link key={f.id} className="chip" href={qs(f.id)} aria-current={filter === f.id ? "true" : undefined}>
                  {f.label}
                </Link>
              ))}
            </div>
            <span className="small faint">Most recently run first</span>
          </div>

          {items.length === 0 ? (
            <div className="panel empty">
              <h3>{sp.q || filter !== "all" ? "Nothing matches" : "No workflows yet"}</h3>
              <p>
                {sp.q || filter !== "all"
                  ? "Try a different search or filter."
                  : user.role === "admin"
                    ? "Add a GitHub connection, then FlowDeck lists every workflow that can be started manually."
                    : "An administrator needs to connect GitHub first."}
              </p>
              {user.role === "admin" && !sp.q && filter === "all" && (
                <Link className="btn btn-primary" href="/settings/connections">
                  Add a GitHub connection
                </Link>
              )}
            </div>
          ) : (
            <div className="panel table-wrap">
              <table className="table" style={{ minWidth: 760 }}>
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th>Owner</th>
                    <th>Last run</th>
                    <th>Success, 30 days</th>
                    <th><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <div className="wf-name">
                          <Link href={`/workflows/${w.id}`}>{w.name}</Link>
                          <span className="mono">{w.repo} / {w.path.replace(".github/workflows/", "")}</span>
                        </div>
                        {(w.gated || w.tags.length > 0) && (
                          <div className="wf-meta">
                            {w.gated && (
                              <span className="pill pill-gate">
                                <Shield />
                                May need approval
                              </span>
                            )}
                            {w.tags.slice(0, 3).map((t) => (
                              <span key={t} className="pill">{t}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="muted">{w.ownerTeam ?? "—"}</td>
                      <td>
                        {w.latest ? (
                          <>
                            <Link href={`/runs/${w.latest.id}`} style={{ textDecoration: "none" }}>
                              <PhaseStatus phase={w.latest.phase} />
                            </Link>
                            <span className="when">
                              {timeAgo(w.latest.createdAt)}
                              {w.latest.requester ? ` by ${w.latest.requester}` : w.latest.actorLogin ? ` by @${w.latest.actorLogin}` : ""}
                            </span>
                          </>
                        ) : (
                          <span className="faint small">Never run</span>
                        )}
                      </td>
                      <td>
                        {w.successRate === null ? (
                          <span className="faint small">No finished runs</span>
                        ) : (
                          <div className="rate">
                            <div className={`rate-bar${w.successRate < 85 ? " low" : ""}`}>
                              <i style={{ width: `${w.successRate}%` }} />
                            </div>
                            <span className="num">{w.successRate}%</span>
                          </div>
                        )}
                      </td>
                      <td>
                        <Link className="btn btn-sm" href={`/workflows/${w.id}`}>
                          Run
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="aside-stack">
          <section className="panel waiting-card" aria-labelledby="waiting-title">
            <div className="panel-head">
              <h2 id="waiting-title">Waiting on you</h2>
              {inbox.length > 0 && <Link className="link small" href="/approvals">See all {inbox.length}</Link>}
            </div>
            <div className="panel-body">
              {inbox.length === 0 ? (
                <p className="muted small">Nothing needs your approval.</p>
              ) : (
                <ul className="mini-list">
                  {inbox.slice(0, 4).map((a) => (
                    <li key={a.id}>
                      <span className="ico ico-wait"><Diamond /></span>
                      <div className="grow">
                        <Link href={a.runRequestId ? `/runs/${a.runRequestId}` : "/approvals"}>
                          <b>{a.workflowName} to {a.environmentName}</b>
                        </Link>
                        <span className="small muted">
                          {a.runNumber ? `Run #${a.runNumber}, ` : ""}waiting {timeAgo(a.createdAt).replace(" ago", "")}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

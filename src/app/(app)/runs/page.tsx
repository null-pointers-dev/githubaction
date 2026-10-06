import Link from "next/link";
import { requireUser } from "@/server/session";
import { listRuns, type RunsFilter } from "@/server/views";
import { PhaseStatus } from "@/components/Status";
import { LiveRefresh } from "@/components/LiveRefresh";
import { formatDuration, timeAgo } from "@/lib/format";

export const metadata = { title: "Runs" };

const FILTERS: Array<{ id: RunsFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "Started by me" },
  { id: "active", label: "Active" },
  { id: "waiting", label: "Waiting for approval" },
  { id: "failed", label: "Failed" },
];

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filter = (FILTERS.find((f) => f.id === sp.filter)?.id ?? "all") as RunsFilter;
  const runs = await listRuns(user.id, filter);

  return (
    <main className="page">
      <LiveRefresh topics={["runs"]} />
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="muted">Every run FlowDeck knows about, including ones started on GitHub.</p>
        </div>
      </div>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Filter runs">
          {FILTERS.map((f) => (
            <Link key={f.id} className="chip" href={f.id === "all" ? "/runs" : `/runs?filter=${f.id}`} aria-current={filter === f.id ? "true" : undefined}>
              {f.label}
            </Link>
          ))}
        </div>
      </div>
      {runs.length === 0 ? (
        <div className="panel empty">
          <h3>No runs here</h3>
          <p>Start one from the workflow catalog.</p>
          <Link className="btn btn-primary" href="/workflows">Browse workflows</Link>
        </div>
      ) : (
        <div className="panel table-wrap">
          <table className="table" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Status</th>
                <th>Started by</th>
                <th>Branch</th>
                <th>Duration</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="wf-name">
                      <Link href={`/runs/${r.id}`}>
                        {r.workflowName}
                        {r.runNumber ? <span className="faint mono"> #{r.runNumber}</span> : null}
                      </Link>
                      <span className="mono">{r.repo}</span>
                    </div>
                  </td>
                  <td><PhaseStatus phase={r.phase} /></td>
                  <td>{r.requester ?? (r.actorLogin ? <span className="muted">@{r.actorLogin} on GitHub</span> : <span className="faint">Unknown</span>)}</td>
                  <td className="mono">{r.ref}</td>
                  <td className="num muted">
                    {r.startedAt ? formatDuration((r.completedAt ?? new Date()).getTime() - r.startedAt.getTime()) : "—"}
                  </td>
                  <td className="muted">{timeAgo(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

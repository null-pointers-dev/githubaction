import { count, desc, isNotNull, max } from "drizzle-orm";
import { db } from "@/server/db";
import { webhookInbox } from "@/server/db/schema";
import { QUEUE, queue, type QueueName } from "@/server/queues";
import { KEYS, redis } from "@/server/redis";
import { LiveRefresh } from "@/components/LiveRefresh";
import { timeAgo } from "@/lib/format";
import { pollNow, retryFailed } from "../actions";

export const metadata = { title: "System health" };
export const dynamic = "force-dynamic";

const LABELS: Record<QueueName, string> = {
  [QUEUE.ingest]: "Incoming GitHub events",
  [QUEUE.dispatch]: "Start, cancel and rerun",
  [QUEUE.reconcile]: "Update runs from GitHub",
  [QUEUE.approval]: "Approvals",
  [QUEUE.sync]: "Workflow sync",
  [QUEUE.poller]: "Minute check",
  [QUEUE.maintenance]: "Maintenance",
};

function seconds(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export default async function HealthPage() {
  const now = Date.now();
  const [pollerRaw, webhookLast, inboxStats, failedRecent] = await Promise.all([
    redis().get(KEYS.pollerLast).catch(() => null),
    redis().get(KEYS.webhookLast).catch(() => null),
    db.select({ total: count(), last: max(webhookInbox.receivedAt) }).from(webhookInbox),
    db.select({ deliveryId: webhookInbox.deliveryId, event: webhookInbox.event, error: webhookInbox.error, receivedAt: webhookInbox.receivedAt })
      .from(webhookInbox).where(isNotNull(webhookInbox.error)).orderBy(desc(webhookInbox.receivedAt)).limit(5),
  ]);
  const poller = pollerRaw ? (JSON.parse(pollerRaw) as { at: number; active: number; queued: number; stuck: number; deciding: number }) : null;
  const counts = await Promise.all(
    (Object.values(QUEUE) as QueueName[]).map(async (name) => ({
      name,
      counts: await queue(name).getJobCounts("waiting", "active", "delayed", "failed").catch(() => null),
    })),
  );
  const workerLate = !poller || now - poller.at > 150_000;

  return (
    <div className="stack">
      <LiveRefresh topics={["runs"]} />
      {workerLate && (
        <p className="callout callout-fail">
          The worker hasn't checked in for {poller ? seconds(now - poller.at) : "a while"}. Runs won't update until it's running (npm run worker).
        </p>
      )}
      <div className="health-cards">
        <section className="panel metric">
          <h3 className="muted" style={{ fontWeight: 500 }}>Webhooks</h3>
          <div className="big">{webhookLast ? seconds(now - Number(webhookLast)) : "None"} <small>{webhookLast ? "since the last event" : "received yet"}</small></div>
          <p className="small muted">{inboxStats[0]?.total ?? 0} stored in the last 14 days. {failedRecent.length ? `${failedRecent.length} recent events failed to process.` : "None failed."}</p>
        </section>
        <section className="panel metric">
          <h3 className="muted" style={{ fontWeight: 500 }}>Minute check</h3>
          <div className="big">{poller ? seconds(now - poller.at) : "Never"} <small>{poller ? "since the last check" : "run"}</small></div>
          <p className="small muted">
            {poller ? `${poller.active} unfinished runs; ${poller.queued} re-checked because no webhook arrived recently.` : "Start the worker to begin checking runs."}
          </p>
        </section>
        <section className="panel metric">
          <h3 className="muted" style={{ fontWeight: 500 }}>Recovery</h3>
          <div className="big">{poller ? poller.stuck + poller.deciding : 0} <small>items retried last check</small></div>
          <p className="small muted">Starts with an unknown outcome and approvals that didn't reach GitHub are retried automatically.</p>
        </section>
      </div>

      <section className="panel" aria-labelledby="queues-title">
        <div className="panel-head">
          <h2 id="queues-title">Background work</h2>
          <form action={pollNow}><button className="btn btn-sm">Check all active runs now</button></form>
        </div>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 640 }}>
            <thead><tr><th>Queue</th><th className="num">Waiting</th><th className="num">Running</th><th className="num">Scheduled</th><th className="num">Failed</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {counts.map(({ name, counts: c }) => (
                <tr key={name}>
                  <td>{LABELS[name]}<div className="small faint mono">{name}</div></td>
                  <td className="num">{c?.waiting ?? "—"}</td>
                  <td className="num">{c?.active ?? "—"}</td>
                  <td className="num">{c?.delayed ?? "—"}</td>
                  <td className="num" style={c?.failed ? { color: "var(--red)", fontWeight: 600 } : undefined}>{c?.failed ?? "—"}</td>
                  <td>
                    {c?.failed ? (
                      <form action={retryFailed.bind(null, name)}><button className="btn btn-sm">Retry failed</button></form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {failedRecent.length > 0 && (
        <section className="panel" aria-labelledby="failed-title">
          <div className="panel-head"><h2 id="failed-title">Events that failed to process</h2></div>
          <div className="panel-body">
            <ul className="mini-list">
              {failedRecent.map((f) => (
                <li key={f.deliveryId}>
                  <span className="ico ico-fail">!</span>
                  <div className="grow">
                    <b>{f.event}</b>
                    <span className="small error-text">{f.error}</span>
                  </div>
                  <span className="small faint">{timeAgo(f.receivedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

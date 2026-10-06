import { asc } from "drizzle-orm";
import { db } from "@/server/db";
import { githubCredentials } from "@/server/db/schema";
import { KEYS, redis } from "@/server/redis";
import { timeAgo } from "@/lib/format";
import { addCredential, deleteCredential, verifyCredential } from "../actions";

export const metadata = { title: "Connections" };

const STATUS: Record<string, { cls: string; label: string }> = {
  healthy: { cls: "s-ok", label: "Healthy" },
  verifying: { cls: "s-run", label: "Checking" },
  expiring: { cls: "s-wait", label: "Expiring soon" },
  error: { cls: "s-fail", label: "Not working" },
};

export default async function ConnectionsPage() {
  const creds = await db.select().from(githubCredentials).orderBy(asc(githubCredentials.owner), asc(githubCredentials.purpose));
  const limits = await redis().hgetall(KEYS.rateLimit).catch(() => ({}) as Record<string, string>);

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="conn-title">
        <div className="panel-head">
          <h2 id="conn-title">GitHub connections</h2>
          <span className="small faint">Each organisation needs a runs connection; add an approver token to approve from FlowDeck.</span>
        </div>
        {creds.length === 0 ? (
          <div className="empty">
            <h3>No connections yet</h3>
            <p>Add one below and FlowDeck will list that organisation's workflows.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 820 }}>
              <thead>
                <tr><th>Connection</th><th>Used for</th><th>Acts as</th><th>Status</th><th>API quota left</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {creds.map((c) => {
                  const st = STATUS[c.status] ?? STATUS.error;
                  const rl = limits[c.id] ? (JSON.parse(limits[c.id]) as { remaining: number; limit: number }) : null;
                  return (
                    <tr key={c.id}>
                      <td>
                        <b>{c.owner}</b>
                        <div className="small faint">{c.name}, {c.kind === "app" ? `GitHub App ${c.appId}` : "personal access token"}</div>
                      </td>
                      <td className="muted">{c.purpose === "approver" ? "Approving deployments" : "Sync, runs, cancel, rerun"}</td>
                      <td className="mono">{c.tokenLogin ? `@${c.tokenLogin}` : "—"}</td>
                      <td>
                        <span className={`status ${st.cls}`}>{st.label}</span>
                        {c.expiresAt && <div className="small faint">Expires {c.expiresAt.toLocaleDateString()}</div>}
                        {c.lastError && <div className="error-text" style={{ maxWidth: 280 }}>{c.lastError}</div>}
                        {c.lastVerifiedAt && <div className="small faint">Checked {timeAgo(c.lastVerifiedAt)}</div>}
                      </td>
                      <td>
                        {rl ? (
                          <>
                            <span className="num">{rl.remaining.toLocaleString()} of {rl.limit.toLocaleString()}</span>
                            <div className="budget"><i style={{ width: `${Math.round((rl.remaining / Math.max(rl.limit, 1)) * 100)}%` }} /></div>
                          </>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td>
                        <div className="row">
                          <form action={verifyCredential.bind(null, c.id)}><button className="btn btn-sm">Check</button></form>
                          <form action={deleteCredential.bind(null, c.id)}><button className="btn btn-sm btn-danger">Remove</button></form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="add-title">
        <div className="panel-head"><h2 id="add-title">Add or replace a connection</h2></div>
        <form action={addCredential} className="panel-body stack" style={{ gap: 18 }}>
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="owner">GitHub organisation or user</label>
              <input className="input mono" id="owner" name="owner" placeholder="acme" required />
            </div>
            <div className="field">
              <label className="label" htmlFor="purpose">Used for</label>
              <select className="select" id="purpose" name="purpose" defaultValue="dispatch">
                <option value="dispatch">Sync, runs, cancel and rerun</option>
                <option value="approver">Approving deployments</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="kind">Type</label>
              <select className="select" id="kind" name="kind" defaultValue="pat">
                <option value="pat">Personal access token</option>
                <option value="app">GitHub App installation</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="name">Label <span className="faint">Optional</span></label>
              <input className="input" id="name" name="name" placeholder="Production approver" />
            </div>
          </div>

          <fieldset className="panel panel-body" style={{ margin: 0 }}>
            <legend className="label" style={{ padding: "0 6px" }}>Personal access token</legend>
            <div className="field">
              <label className="label" htmlFor="token">Token</label>
              <input className="input mono" id="token" name="token" type="password" autoComplete="off" placeholder="github_pat_…" />
              <span className="hint">
                Runs connection: fine-grained token with Actions (read and write), Contents (read), Deployments (read) and Environments (read); add Members (read) at organisation level if teams review deployments.
                Approver token: must belong to an account listed as a required reviewer on the protected environments, and should be a different account from the runs connection, because GitHub blocks approving your own runs when "Prevent self-review" is on.
              </span>
            </div>
          </fieldset>

          <fieldset className="panel panel-body" style={{ margin: 0 }}>
            <legend className="label" style={{ padding: "0 6px" }}>GitHub App (runs connection only)</legend>
            <div className="form-grid">
              <div className="field">
                <label className="label" htmlFor="appId">App ID</label>
                <input className="input mono" id="appId" name="appId" inputMode="numeric" />
              </div>
              <div className="field">
                <label className="label" htmlFor="installationId">Installation ID</label>
                <input className="input mono" id="installationId" name="installationId" inputMode="numeric" />
              </div>
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <label className="label" htmlFor="privateKey">Private key</label>
              <textarea className="textarea mono" id="privateKey" name="privateKey" rows={4} placeholder="-----BEGIN RSA PRIVATE KEY-----" />
            </div>
          </fieldset>

          <p className="small faint">Secrets are encrypted before they're stored and are never shown again. Saving a connection for the same organisation and use replaces the old one.</p>
          <div><button className="btn btn-primary">Save and check connection</button></div>
        </form>
      </section>
    </div>
  );
}

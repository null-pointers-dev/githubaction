import { asc } from "drizzle-orm";
import { db } from "@/server/db";
import { approvalPolicies, githubCredentials, repositories, user as users } from "@/server/db/schema";
import { getApprovalDefaults } from "@/server/settings";
import { addPolicy, deletePolicy, saveApprovalDefaults } from "../actions";

export const metadata = { title: "Approval settings" };

export default async function ApprovalSettingsPage() {
  const [defaults, policies, repos, people, approvers] = await Promise.all([
    getApprovalDefaults(),
    db.select().from(approvalPolicies).orderBy(asc(approvalPolicies.createdAt)),
    db.select({ id: repositories.id, fullName: repositories.fullName, environments: repositories.environments }).from(repositories).orderBy(asc(repositories.fullName)),
    db.select({ id: users.id, name: users.name, email: users.email }).from(users).orderBy(asc(users.name)),
    db.select().from(githubCredentials),
  ]);
  const repoName = new Map(repos.map((r) => [r.id, r.fullName]));
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const envNames = [...new Set(repos.flatMap((r) => r.environments.filter((e) => e.protected).map((e) => e.name)))].sort();
  const owners = [...new Set(approvers.map((c) => c.owner))];
  const missingApprover = owners.filter((o) => !approvers.some((c) => c.owner === o && c.purpose === "approver"));

  return (
    <div className="stack">
      <p className="callout callout-info">
        Decisions are always sent to GitHub with the approver token for that organisation, and FlowDeck records who actually approved. The settings below decide which FlowDeck users can approve. A request only appears for people who are allowed to approve it, and the server refuses everyone else.
      </p>
      {missingApprover.length > 0 && (
        <p className="callout callout-wait">
          No approver token for {missingApprover.join(", ")}. Approving in FlowDeck will fail there until one is added under Connections.
        </p>
      )}

      <section className="panel" aria-labelledby="default-title">
        <div className="panel-head"><h2 id="default-title">Default for every environment</h2></div>
        <form action={saveApprovalDefaults} className="panel-body stack" style={{ gap: 16 }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend className="label" style={{ marginBottom: 10 }}>Who can approve</legend>
            <label className="check">
              <input type="radio" name="mode" value="github" defaultChecked={defaults.mode === "github"} />
              Mirror GitHub. People whose linked GitHub account is a required reviewer (directly or through a team) on that environment.
            </label>
            <label className="check">
              <input type="radio" name="mode" value="flowdeck" defaultChecked={defaults.mode === "flowdeck"} />
              FlowDeck approvers. People or roles you choose below, per environment.
            </label>
          </fieldset>
          <label className="check">
            <input type="checkbox" name="preventSelfApproval" defaultChecked={defaults.preventSelfApproval} />
            People can't approve runs they started
          </label>
          <div><button className="btn btn-primary">Save default</button></div>
        </form>
      </section>

      <section className="panel" aria-labelledby="rules-title">
        <div className="panel-head">
          <h2 id="rules-title">Environment rules</h2>
          <span className="small faint">The most specific rule wins: repository and environment, then repository, then environment, then the default.</span>
        </div>
        {policies.length === 0 ? (
          <p className="panel-body muted">No rules yet. Every environment uses the default.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 720 }}>
              <thead><tr><th>Repository</th><th>Environment</th><th>Who can approve</th><th>Self-approval</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.id}>
                    <td>{p.repositoryId ? <span className="mono">{repoName.get(p.repositoryId) ?? "Deleted repository"}</span> : "Any repository"}</td>
                    <td className="mono">{p.environmentName === "*" ? "Any environment" : p.environmentName}</td>
                    <td>
                      {p.mode === "github"
                        ? "GitHub reviewers"
                        : [
                            ...p.approverRoles.map((r) => (r === "admin" ? "Administrators" : "Members")),
                            ...p.approverUserIds.map((id) => personName.get(id) ?? "Removed user"),
                          ].join(", ") || <span className="error-text">Nobody</span>}
                    </td>
                    <td className="muted">{p.preventSelfApproval ? "Not allowed" : "Allowed"}</td>
                    <td>
                      <form action={deletePolicy.bind(null, p.id)}><button className="btn btn-sm btn-danger">Remove</button></form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="add-rule-title">
        <div className="panel-head"><h2 id="add-rule-title">Add a rule</h2></div>
        <form action={addPolicy} className="panel-body stack" style={{ gap: 18 }}>
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="repositoryId">Repository</label>
              <select className="select" id="repositoryId" name="repositoryId" defaultValue="">
                <option value="">Any repository</option>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="environmentName">Environment</label>
              <input className="input mono" id="environmentName" name="environmentName" list="env-names" placeholder="production, or * for any" defaultValue="" />
              <datalist id="env-names">{envNames.map((e) => <option key={e} value={e} />)}</datalist>
            </div>
            <div className="field">
              <label className="label" htmlFor="mode">Who can approve</label>
              <select className="select" id="mode" name="mode" defaultValue="flowdeck">
                <option value="flowdeck">FlowDeck approvers (choose below)</option>
                <option value="github">Mirror GitHub reviewers</option>
              </select>
            </div>
          </div>
          <div className="form-grid" style={{ alignItems: "start" }}>
            <div className="field">
              <label className="label" htmlFor="approverUserIds">People <span className="faint">For FlowDeck approvers</span></label>
              <select className="select" id="approverUserIds" name="approverUserIds" multiple size={Math.min(6, Math.max(3, people.length))}>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
              </select>
              <span className="hint">Hold Ctrl or Cmd to choose several.</span>
            </div>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label">Roles <span className="faint">Optional</span></legend>
              <label className="check" style={{ marginTop: 8 }}><input type="checkbox" name="approverRoles" value="admin" /> Administrators</label>
              <label className="check"><input type="checkbox" name="approverRoles" value="member" /> All members</label>
              <label className="check" style={{ marginTop: 14 }}><input type="checkbox" name="preventSelfApproval" defaultChecked /> People can't approve runs they started</label>
            </fieldset>
          </div>
          <div><button className="btn btn-primary">Add rule</button></div>
        </form>
      </section>
    </div>
  );
}

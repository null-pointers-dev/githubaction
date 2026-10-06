import { requireUser } from "@/server/session";
import { config } from "@/server/config";
import { getApprovalDefaults } from "@/server/settings";
import { Avatar } from "@/components/Status";
import { LinkGitHubButton, SignOutButton } from "@/components/AccountActions";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser();
  const defaults = await getApprovalDefaults();
  return (
    <main className="page" style={{ maxWidth: 760 }}>
      <div className="page-head">
        <div className="row" style={{ gap: 14 }}>
          <Avatar name={user.name} size={44} />
          <div>
            <h1>{user.name}</h1>
            <p className="muted">{user.email}</p>
          </div>
        </div>
        <SignOutButton />
      </div>

      <section className="panel" aria-labelledby="gh-title">
        <div className="panel-head"><h2 id="gh-title">GitHub account</h2></div>
        <div className="panel-body stack" style={{ gap: 14 }}>
          <table className="kv">
            <tbody>
              <tr><td>Role in FlowDeck</td><td>{user.role === "admin" ? "Administrator" : "Member"}</td></tr>
              <tr><td>GitHub username</td><td className="mono">{user.githubLogin ? `@${user.githubLogin}` : "Not linked"}</td></tr>
            </tbody>
          </table>
          <p className="muted small">
            {defaults.mode === "github"
              ? "Approvals follow GitHub's environment reviewers. FlowDeck uses your GitHub username to know which deployments you can approve."
              : "Approvals are managed in FlowDeck, so linking GitHub is optional."}
          </p>
          {config.githubLoginEnabled ? (
            <div><LinkGitHubButton linked={!!user.githubLogin} /></div>
          ) : (
            <p className="callout callout-info">GitHub sign-in isn't configured. An administrator can set your GitHub username under Settings, People.</p>
          )}
        </div>
      </section>
    </main>
  );
}

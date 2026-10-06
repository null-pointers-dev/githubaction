import { asc } from "drizzle-orm";
import { db } from "@/server/db";
import { user as users } from "@/server/db/schema";
import { requireAdmin } from "@/server/session";
import { Avatar } from "@/components/Status";
import { updateUser } from "../actions";

export const metadata = { title: "People" };

export default async function UsersPage() {
  const me = await requireAdmin();
  const people = await db.select().from(users).orderBy(asc(users.name));
  return (
    <section className="panel" aria-labelledby="people-title">
      <div className="panel-head">
        <h2 id="people-title">People</h2>
        <span className="small faint">GitHub usernames link people to GitHub's environment reviewers. They're filled in automatically when someone signs in with GitHub.</span>
      </div>
      <div className="table-wrap">
        <table className="table" style={{ minWidth: 760 }}>
          <thead><tr><th>Person</th><th>Role</th><th>GitHub username</th><th><span className="sr-only">Save</span></th></tr></thead>
          <tbody>
            {people.map((p) => {
              const formId = `user-${p.id}`;
              return (
                <tr key={p.id}>
                  <td>
                    <div className="row" style={{ gap: 10 }}>
                      <Avatar name={p.name} />
                      <div><b>{p.name}</b>{p.id === me.id && <span className="faint"> (you)</span>}<div className="small faint">{p.email}</div></div>
                    </div>
                  </td>
                  <td>
                    <select className="select" name="role" form={formId} defaultValue={p.role} aria-label={`Role for ${p.name}`} style={{ minWidth: 150 }}>
                      <option value="member">Member</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </td>
                  <td>
                    <input className="input mono" name="githubLogin" form={formId} defaultValue={p.githubLogin ?? ""} placeholder="octocat" aria-label={`GitHub username for ${p.name}`} />
                  </td>
                  <td>
                    <form id={formId} action={updateUser.bind(null, p.id)}>
                      <button className="btn btn-sm">Save</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

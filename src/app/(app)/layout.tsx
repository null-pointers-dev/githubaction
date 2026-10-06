import Link from "next/link";
import { requireUser } from "@/server/session";
import { countInbox } from "@/server/views";
import { NavLinks } from "@/components/NavLinks";
import { Avatar } from "@/components/Status";
import { Logo } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const pending = await countInbox(user).catch(() => 0);
  return (
    <div className="app">
      <aside className="rail">
        <Link className="brand" href="/workflows" aria-label="FlowDeck home">
          <Logo />
          <b>FlowDeck</b>
        </Link>
        <NavLinks pending={pending} isAdmin={user.role === "admin"} />
        <Link className="rail-foot" href="/account">
          <Avatar name={user.name} />
          <div className="who">
            <b>{user.name}</b>
            <span>{user.role === "admin" ? "Administrator" : user.githubLogin ? `@${user.githubLogin}` : "Member"}</span>
          </div>
        </Link>
      </aside>
      <div className="main">
        <header className="topbar">
          <form className="search" role="search" action="/workflows">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <label className="sr-only" htmlFor="q">Search workflows</label>
            <input id="q" name="q" placeholder="Search workflows, repositories and teams" />
          </form>
        </header>
        {children}
      </div>
    </div>
  );
}

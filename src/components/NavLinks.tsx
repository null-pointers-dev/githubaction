"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcons } from "./icons";

export function NavLinks({ pending, isAdmin }: { pending: number; isAdmin: boolean }) {
  const path = usePathname();
  const current = (prefix: string) => (path === prefix || path.startsWith(`${prefix}/`) ? "page" : undefined);
  return (
    <>
      <nav className="nav" aria-label="Main">
        <Link href="/workflows" aria-current={current("/workflows")}>
          {NavIcons.workflows}
          Workflows
        </Link>
        <Link href="/runs" aria-current={current("/runs")}>
          {NavIcons.runs}
          Runs
        </Link>
        <Link href="/approvals" aria-current={current("/approvals")}>
          {NavIcons.approvals}
          Approvals
          {pending > 0 && (
            <span className="count" aria-label={`${pending} waiting for you`}>
              {pending}
            </span>
          )}
        </Link>
      </nav>
      {isAdmin && (
        <nav className="nav" aria-label="Admin">
          <div className="nav-group">Admin</div>
          <Link href="/settings/connections" aria-current={current("/settings")}>
            {NavIcons.settings}
            Settings
          </Link>
        </nav>
      )}
    </>
  );
}

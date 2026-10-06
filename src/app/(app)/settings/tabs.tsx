"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/connections", label: "Connections" },
  { href: "/settings/approvals", label: "Approvals" },
  { href: "/settings/users", label: "People" },
  { href: "/settings/health", label: "System health" },
];

export function SettingsTabs() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Settings sections">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={path.startsWith(t.href) ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

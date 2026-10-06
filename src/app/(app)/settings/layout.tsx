import { requireAdmin } from "@/server/session";
import { SettingsTabs } from "./tabs";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Connections to GitHub, who can approve deployments, and how FlowDeck is keeping up.</p>
        </div>
      </div>
      <SettingsTabs />
      {children}
    </main>
  );
}

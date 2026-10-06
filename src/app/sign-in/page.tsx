import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Logo } from "@/components/icons";
import { config } from "@/server/config";
import { getUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function SignIn() {
  if (await getUser()) redirect("/workflows");
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <Logo />
          <b>FlowDeck</b>
        </div>
        <h1>Sign in</h1>
        <p className="muted" style={{ marginBottom: 22 }}>Run, approve and track your team's GitHub workflows.</p>
        <AuthForm mode="sign-in" githubEnabled={config.githubLoginEnabled} />
      </div>
    </main>
  );
}

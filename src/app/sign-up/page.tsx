import { redirect } from "next/navigation";
import { count } from "drizzle-orm";
import { AuthForm } from "@/components/AuthForm";
import { Logo } from "@/components/icons";
import { config } from "@/server/config";
import { getUser } from "@/server/session";
import { db } from "@/server/db";
import { user } from "@/server/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create account" };

export default async function SignUp() {
  if (await getUser()) redirect("/workflows");
  const [{ n }] = await db.select({ n: count() }).from(user);
  const open = n === 0 || config.allowSignup;
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <Logo />
          <b>FlowDeck</b>
        </div>
        <h1>{n === 0 ? "Set up FlowDeck" : "Create your account"}</h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          {n === 0 ? "The first account becomes the administrator." : "You'll be able to run workflows once you're in."}
        </p>
        {open ? (
          <AuthForm mode="sign-up" githubEnabled={config.githubLoginEnabled} />
        ) : (
          <p className="callout callout-info">New accounts are turned off. Ask a FlowDeck administrator to invite you.</p>
        )}
      </div>
    </main>
  );
}

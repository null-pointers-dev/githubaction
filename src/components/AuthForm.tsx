"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode, githubEnabled }: { mode: "sign-in" | "sign-up"; githubEnabled: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const res =
      mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: String(form.get("name") ?? "") });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "That didn't work. Check your details and try again.");
      return;
    }
    router.push("/workflows");
    router.refresh();
  }

  async function github() {
    await authClient.signIn.social({ provider: "github", callbackURL: "/workflows" });
  }

  return (
    <>
      {githubEnabled && (
        <>
          <button type="button" className="btn" style={{ width: "100%" }} onClick={github}>
            Continue with GitHub
          </button>
          <div className="divider">or</div>
        </>
      )}
      <form onSubmit={onSubmit}>
        {mode === "sign-up" && (
          <div className="field">
            <label className="label" htmlFor="name">Full name</label>
            <input className="input" id="name" name="name" autoComplete="name" required />
          </div>
        )}
        <div className="field">
          <label className="label" htmlFor="email">Work email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="field">
          <label className="label" htmlFor="password">Password</label>
          <input
            className="input"
            id="password"
            name="password"
            type="password"
            minLength={10}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            required
          />
          {mode === "sign-up" && <span className="hint">At least 10 characters.</span>}
        </div>
        {error && (
          <p className="callout callout-fail" style={{ marginTop: 16 }} role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" style={{ width: "100%", marginTop: 20 }} disabled={busy}>
          {mode === "sign-in" ? (busy ? "Signing in…" : "Sign in") : busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="small muted" style={{ marginTop: 18, textAlign: "center" }}>
        {mode === "sign-in" ? (
          <>
            New here? <Link className="link" href="/sign-up">Create an account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link className="link" href="/sign-in">Sign in</Link>
          </>
        )}
      </p>
    </>
  );
}

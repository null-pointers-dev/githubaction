"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="btn"
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

export function LinkGitHubButton({ linked }: { linked: boolean }) {
  return (
    <button
      className="btn"
      onClick={() => authClient.linkSocial({ provider: "github", callbackURL: "/account" })}
    >
      {linked ? "Re-link GitHub account" : "Link GitHub account"}
    </button>
  );
}

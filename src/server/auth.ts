import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { nextCookies } from "better-auth/next-js";
import { count, eq } from "drizzle-orm";
import { db } from "./db";
import * as schema from "./db/schema";
import { config } from "./config";

const githubProvider =
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
          scope: ["read:user", "user:email"],
        },
      }
    : {};

/** Looks up the GitHub username for a GitHub OAuth access token. */
async function githubLoginFor(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { login?: string };
    return body.login ?? null;
  } catch {
    return null;
  }
}

export const auth = betterAuth({
  appName: "FlowDeck",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
  socialProviders: githubProvider,
  account: { accountLinking: { enabled: true, trustedProviders: ["github"] } },
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "member", input: false },
      githubLogin: { type: "string", required: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (newUser) => {
          const [{ n }] = await db.select({ n: count() }).from(schema.user);
          if (n > 0 && !config.allowSignup) return false;
          return { data: { ...newUser, role: n === 0 ? "admin" : "member" } };
        },
      },
    },
    account: {
      create: {
        // Record the GitHub username when someone signs in with or links GitHub.
        // It decides whether they match GitHub's environment reviewers.
        after: async (acc) => {
          if (acc.providerId !== "github" || !acc.accessToken) return;
          const login = await githubLoginFor(acc.accessToken);
          if (login) await db.update(schema.user).set({ githubLogin: login }).where(eq(schema.user.id, acc.userId));
        },
      },
    },
  },
  plugins: [nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;

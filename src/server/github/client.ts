import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { githubCredentials, type CredentialPurpose } from "../db/schema";
import { decryptJson } from "../crypto";
import { config } from "../config";
import { KEYS, redis } from "../redis";

export type Credential = typeof githubCredentials.$inferSelect;
type Secret = { token?: string; privateKey?: string };

export class NoCredentialError extends Error {
  constructor(owner: string, purpose: CredentialPurpose) {
    super(
      purpose === "approver"
        ? `No approver token is set up for ${owner}. An admin can add one under Settings, Connections.`
        : `No GitHub connection is set up for ${owner}. An admin can add one under Settings, Connections.`,
    );
    this.name = "NoCredentialError";
  }
}

export type GitHubError = Error & { status: number; response?: { headers?: Record<string, string>; data?: unknown } };

export function isGitHubError(e: unknown): e is GitHubError {
  return typeof e === "object" && e !== null && typeof (e as { status?: unknown }).status === "number";
}

/** Human message for a GitHub API error. */
export function githubMessage(e: unknown): string {
  if (isGitHubError(e)) {
    const data = e.response?.data as { message?: string; errors?: Array<{ message?: string } | string> } | undefined;
    const details = (data?.errors ?? [])
      .map((x) => (typeof x === "string" ? x : x.message))
      .filter(Boolean)
      .join("; ");
    return `GitHub returned ${e.status}: ${data?.message ?? e.message}${details ? ` (${details})` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const cache = new Map<string, Octokit>();

function attachRateLimitHook(octokit: Octokit, credentialId: string) {
  octokit.hook.after("request", async (response) => {
    const h = response.headers as Record<string, string | undefined>;
    if (h["x-ratelimit-remaining"] === undefined) return;
    await redis()
      .hset(
        KEYS.rateLimit,
        credentialId,
        JSON.stringify({
          remaining: Number(h["x-ratelimit-remaining"]),
          limit: Number(h["x-ratelimit-limit"]),
          reset: Number(h["x-ratelimit-reset"]),
          at: Date.now(),
        }),
      )
      .catch(() => undefined);
  });
}

export function octokitFor(cred: Credential): Octokit {
  const cacheKey = `${cred.id}:${cred.updatedAt.getTime()}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const secret = decryptJson<Secret>(cred.encryptedSecret);
  let octokit: Octokit;
  if (cred.kind === "app") {
    if (!cred.appId || !cred.installationId || !secret.privateKey) throw new Error(`Connection "${cred.name}" is missing App details.`);
    octokit = new Octokit({
      baseUrl: config.githubApiUrl,
      userAgent: "flowdeck",
      authStrategy: createAppAuth,
      auth: { appId: Number(cred.appId), privateKey: secret.privateKey, installationId: Number(cred.installationId) },
    });
  } else {
    if (!secret.token) throw new Error(`Connection "${cred.name}" has no token.`);
    octokit = new Octokit({ baseUrl: config.githubApiUrl, userAgent: "flowdeck", auth: secret.token });
  }
  attachRateLimitHook(octokit, cred.id);
  cache.set(cacheKey, octokit);
  return octokit;
}

/** App-level client (JWT), used for App metadata and webhook redelivery. */
export function appOctokitFor(cred: Credential): Octokit | null {
  if (cred.kind !== "app" || !cred.appId) return null;
  const secret = decryptJson<Secret>(cred.encryptedSecret);
  if (!secret.privateKey) return null;
  return new Octokit({
    baseUrl: config.githubApiUrl,
    userAgent: "flowdeck",
    authStrategy: createAppAuth,
    auth: { appId: Number(cred.appId), privateKey: secret.privateKey },
  });
}

export async function getCredential(owner: string, purpose: CredentialPurpose): Promise<Credential | null> {
  const rows = await db
    .select()
    .from(githubCredentials)
    .where(and(sql`lower(${githubCredentials.owner}) = lower(${owner})`, eq(githubCredentials.purpose, purpose)))
    .limit(1);
  return rows[0] ?? null;
}

export async function clientFor(owner: string, purpose: CredentialPurpose = "dispatch") {
  const credential = await getCredential(owner, purpose);
  if (!credential) throw new NoCredentialError(owner, purpose);
  return { octokit: octokitFor(credential), credential };
}

/**
 * Untyped request helper. Keeps the code independent of Octokit's generated
 * endpoint types, which change as GitHub adds parameters.
 */
export async function gh<T = any>(
  octokit: Octokit,
  route: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; data: T; headers: Record<string, string | undefined> }> {
  const res = await octokit.request(route as string, params);
  return { status: res.status, data: res.data as T, headers: res.headers as Record<string, string | undefined> };
}

export async function ghPaginate<T = any>(octokit: Octokit, route: string, params: Record<string, unknown> = {}): Promise<T[]> {
  return (await octokit.paginate(route as string, { per_page: 100, ...params })) as T[];
}

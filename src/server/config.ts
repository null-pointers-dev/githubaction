/** Reads configuration lazily so `next build` works without runtime secrets. */
export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export const config = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get redisUrl() {
    return process.env.REDIS_URL || "redis://localhost:6379";
  },
  get githubApiUrl() {
    return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  },
  get webhookSecrets(): string[] {
    return [process.env.GITHUB_WEBHOOK_SECRET, process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS].filter(
      (s): s is string => !!s,
    );
  },
  get githubLoginEnabled() {
    return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  },
  get allowSignup() {
    return (process.env.ALLOW_SIGNUP ?? "true").toLowerCase() !== "false";
  },
};

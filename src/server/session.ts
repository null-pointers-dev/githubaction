import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export type AppUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  githubLogin: string | null;
};

function toAppUser(u: Record<string, unknown> | undefined | null): AppUser | null {
  if (!u) return null;
  return {
    id: String(u.id),
    name: String(u.name ?? ""),
    email: String(u.email ?? ""),
    role: String(u.role ?? "member"),
    githubLogin: (u.githubLogin as string | null | undefined) ?? null,
  };
}

/** For server components and server actions. */
export async function getUser(): Promise<AppUser | null> {
  const s = await auth.api.getSession({ headers: await headers() });
  return toAppUser(s?.user as Record<string, unknown> | undefined);
}

export async function requireUser(): Promise<AppUser> {
  const u = await getUser();
  if (!u) redirect("/sign-in");
  return u;
}

export async function requireAdmin(): Promise<AppUser> {
  const u = await requireUser();
  if (u.role !== "admin") redirect("/workflows");
  return u;
}

/** For route handlers. */
export async function apiUser(req: Request): Promise<AppUser | null> {
  const s = await auth.api.getSession({ headers: req.headers });
  return toAppUser(s?.user as Record<string, unknown> | undefined);
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

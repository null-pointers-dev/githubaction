import { db } from "../db";
import { approvalPolicies, githubTeamMembers, type ApprovalMode, type Reviewer } from "../db/schema";
import { getApprovalDefaults, type ApprovalDefaults } from "../settings";
import type { AppUser } from "../session";

type Policy = typeof approvalPolicies.$inferSelect;

export type PolicyContext = {
  defaults: ApprovalDefaults;
  policies: Policy[];
  /** "org/slug" (lower-case) -> set of lower-case logins */
  teams: Map<string, Set<string>>;
};

export type ResolvedPolicy = {
  mode: ApprovalMode;
  preventSelfApproval: boolean;
  approverUserIds: string[];
  approverRoles: string[];
  source: "repository" | "global" | "default";
};

export type GateInfo = {
  repositoryId: string;
  owner: string;
  environmentName: string;
  reviewers: Reviewer[];
  /** FlowDeck user who started the run, if it was started in FlowDeck. */
  requestedBy: string | null;
};

export type Eligibility = { allowed: boolean; reason: string; mode: ApprovalMode };

export async function loadPolicyContext(): Promise<PolicyContext> {
  const [defaults, policies, members] = await Promise.all([
    getApprovalDefaults(),
    db.select().from(approvalPolicies),
    db.select().from(githubTeamMembers),
  ]);
  const teams = new Map<string, Set<string>>();
  for (const m of members) {
    const k = `${m.org}/${m.teamSlug}`.toLowerCase();
    if (!teams.has(k)) teams.set(k, new Set());
    teams.get(k)!.add(m.login.toLowerCase());
  }
  return { defaults, policies, teams };
}

export function resolvePolicy(ctx: PolicyContext, repositoryId: string, environmentName: string): ResolvedPolicy {
  const env = environmentName.toLowerCase();
  const candidates: Array<[Policy | undefined, ResolvedPolicy["source"]]> = [
    [ctx.policies.find((p) => p.repositoryId === repositoryId && p.environmentName.toLowerCase() === env), "repository"],
    [ctx.policies.find((p) => p.repositoryId === repositoryId && p.environmentName === "*"), "repository"],
    [ctx.policies.find((p) => !p.repositoryId && p.environmentName.toLowerCase() === env), "global"],
    [ctx.policies.find((p) => !p.repositoryId && p.environmentName === "*"), "global"],
  ];
  for (const [p, source] of candidates) {
    if (p)
      return {
        mode: p.mode,
        preventSelfApproval: p.preventSelfApproval,
        approverUserIds: p.approverUserIds,
        approverRoles: p.approverRoles,
        source,
      };
  }
  return {
    mode: ctx.defaults.mode,
    preventSelfApproval: ctx.defaults.preventSelfApproval,
    approverUserIds: [],
    approverRoles: [],
    source: "default",
  };
}

/**
 * Decides whether a FlowDeck user may approve a deployment gate.
 * GitHub only ever sees the approver token, so this check is the real gate:
 * requests that fail it are never shown to the user, and the API refuses them.
 */
export function evaluate(ctx: PolicyContext, user: AppUser, gate: GateInfo): Eligibility {
  const policy = resolvePolicy(ctx, gate.repositoryId, gate.environmentName);

  if (policy.preventSelfApproval && gate.requestedBy && gate.requestedBy === user.id) {
    return { allowed: false, reason: "You started this run, so someone else has to approve it.", mode: policy.mode };
  }

  if (policy.mode === "flowdeck") {
    const byUser = policy.approverUserIds.includes(user.id);
    const byRole = policy.approverRoles.includes(user.role);
    if (byUser || byRole) return { allowed: true, reason: "You're an approver for this environment in FlowDeck.", mode: "flowdeck" };
    if (policy.approverUserIds.length === 0 && policy.approverRoles.length === 0)
      return { allowed: false, reason: `No FlowDeck approvers are set for ${gate.environmentName}.`, mode: "flowdeck" };
    return { allowed: false, reason: `You're not an approver for ${gate.environmentName}.`, mode: "flowdeck" };
  }

  // Mirror GitHub: the user's GitHub login must be a required reviewer, directly or via a team.
  if (!user.githubLogin) {
    return {
      allowed: false,
      reason: "Link your GitHub account so FlowDeck can match you to GitHub's reviewers.",
      mode: "github",
    };
  }
  const login = user.githubLogin.toLowerCase();
  for (const r of gate.reviewers) {
    if (r.type === "User" && r.login.toLowerCase() === login) {
      return { allowed: true, reason: "You're a required reviewer on GitHub.", mode: "github" };
    }
    if (r.type === "Team") {
      const members = ctx.teams.get(`${r.org}/${r.slug}`.toLowerCase());
      if (members?.has(login)) return { allowed: true, reason: `You're in the ${r.name ?? r.slug} team on GitHub.`, mode: "github" };
    }
  }
  if (gate.reviewers.length === 0) {
    return { allowed: false, reason: "GitHub lists no reviewers for this gate.", mode: "github" };
  }
  return { allowed: false, reason: `You're not a reviewer for ${gate.environmentName} on GitHub.`, mode: "github" };
}

export function describeReviewers(reviewers: Reviewer[]): string {
  if (reviewers.length === 0) return "no reviewers";
  return reviewers.map((r) => (r.type === "User" ? `@${r.login}` : `${r.name ?? r.slug} team`)).join(", ");
}

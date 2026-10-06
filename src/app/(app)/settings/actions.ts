"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { approvalPolicies, githubCredentials, user as users, type ApprovalMode, type CredentialKind, type CredentialPurpose } from "@/server/db/schema";
import { requireAdmin } from "@/server/session";
import { encryptJson } from "@/server/crypto";
import { enqueue, queue, QUEUE, type QueueName } from "@/server/queues";
import { audit } from "@/server/audit";
import { setApprovalDefaults } from "@/server/settings";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function addCredential(form: FormData) {
  const admin = await requireAdmin();
  const kind: CredentialKind = str(form, "kind") === "app" ? "app" : "pat";
  const purpose: CredentialPurpose = str(form, "purpose") === "approver" ? "approver" : "dispatch";
  const owner = str(form, "owner");
  const name = str(form, "name") || `${owner} ${purpose === "approver" ? "approver" : "connection"}`;
  if (!owner) throw new Error("Enter the GitHub organisation or user name.");
  if (kind === "app" && purpose === "approver") {
    throw new Error("Approvals need a personal access token from an account listed as a required reviewer. GitHub Apps can't be reviewers.");
  }

  const secret = kind === "app" ? { privateKey: str(form, "privateKey") } : { token: str(form, "token") };
  if (kind === "app" && (!str(form, "appId") || !str(form, "installationId") || !secret.privateKey)) {
    throw new Error("A GitHub App needs its App ID, installation ID and private key.");
  }
  if (kind === "pat" && !("token" in secret && secret.token)) throw new Error("Paste the token.");

  const values = {
    name,
    owner,
    kind,
    purpose,
    encryptedSecret: encryptJson(secret),
    appId: kind === "app" ? str(form, "appId") : null,
    installationId: kind === "app" ? str(form, "installationId") : null,
    status: "verifying" as const,
    lastError: null,
    tokenLogin: null,
    expiresAt: null,
    createdBy: admin.id,
    updatedAt: new Date(),
  };
  const [saved] = await db
    .insert(githubCredentials)
    .values(values)
    .onConflictDoUpdate({ target: [githubCredentials.owner, githubCredentials.purpose], set: values })
    .returning({ id: githubCredentials.id });

  await audit({ actorUserId: admin.id, action: "credential.saved", resourceType: "credential", resourceId: saved.id, data: { owner, kind, purpose } });
  await enqueue.verifyCredential(saved.id);
  revalidatePath("/settings/connections");
}

export async function deleteCredential(id: string) {
  const admin = await requireAdmin();
  await db.delete(githubCredentials).where(eq(githubCredentials.id, id));
  await audit({ actorUserId: admin.id, action: "credential.deleted", resourceType: "credential", resourceId: id });
  revalidatePath("/settings/connections");
}

export async function verifyCredential(id: string) {
  await requireAdmin();
  await db.update(githubCredentials).set({ status: "verifying" }).where(eq(githubCredentials.id, id));
  await enqueue.verifyCredential(id);
  revalidatePath("/settings/connections");
}

export async function syncNow() {
  const admin = await requireAdmin();
  await enqueue.syncAll();
  await audit({ actorUserId: admin.id, action: "sync.requested", resourceType: "system" });
  revalidatePath("/workflows");
}

export async function pollNow() {
  await requireAdmin();
  await enqueue.pollNow();
  revalidatePath("/settings/health");
}

export async function retryFailed(name: string) {
  await requireAdmin();
  if (!Object.values(QUEUE).includes(name as QueueName)) return;
  await queue(name as QueueName).retryJobs({ state: "failed" });
  revalidatePath("/settings/health");
}

export async function saveApprovalDefaults(form: FormData) {
  const admin = await requireAdmin();
  const mode: ApprovalMode = str(form, "mode") === "flowdeck" ? "flowdeck" : "github";
  const preventSelfApproval = form.get("preventSelfApproval") === "on";
  await setApprovalDefaults({ mode, preventSelfApproval });
  await audit({ actorUserId: admin.id, action: "approvals.defaults_saved", resourceType: "settings", data: { mode, preventSelfApproval } });
  revalidatePath("/settings/approvals");
}

export async function addPolicy(form: FormData) {
  const admin = await requireAdmin();
  const repositoryId = str(form, "repositoryId") || null;
  const environmentName = str(form, "environmentName") || "*";
  const mode: ApprovalMode = str(form, "mode") === "flowdeck" ? "flowdeck" : "github";
  const approverUserIds = form.getAll("approverUserIds").map(String).filter(Boolean);
  const approverRoles = form.getAll("approverRoles").map(String).filter(Boolean);
  const preventSelfApproval = form.get("preventSelfApproval") === "on";
  const [saved] = await db
    .insert(approvalPolicies)
    .values({ repositoryId, environmentName, mode, approverUserIds, approverRoles, preventSelfApproval })
    .returning({ id: approvalPolicies.id });
  await audit({
    actorUserId: admin.id,
    action: "approvals.policy_added",
    resourceType: "approval_policy",
    resourceId: saved.id,
    data: { repositoryId, environmentName, mode, approverUserIds, approverRoles, preventSelfApproval },
  });
  revalidatePath("/settings/approvals");
}

export async function deletePolicy(id: string) {
  const admin = await requireAdmin();
  await db.delete(approvalPolicies).where(eq(approvalPolicies.id, id));
  await audit({ actorUserId: admin.id, action: "approvals.policy_deleted", resourceType: "approval_policy", resourceId: id });
  revalidatePath("/settings/approvals");
}

export async function updateUser(id: string, form: FormData) {
  const admin = await requireAdmin();
  const role = str(form, "role") === "admin" ? "admin" : "member";
  const githubLogin = str(form, "githubLogin").replace(/^@/, "") || null;
  if (id === admin.id && role !== "admin") throw new Error("You can't remove your own admin role.");
  await db.update(users).set({ role, githubLogin, updatedAt: new Date() }).where(eq(users.id, id));
  await audit({ actorUserId: admin.id, action: "user.updated", resourceType: "user", resourceId: id, data: { role, githubLogin } });
  revalidatePath("/settings/users");
}

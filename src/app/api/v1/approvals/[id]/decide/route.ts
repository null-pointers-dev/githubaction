import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { approvalRequests, repositories, runRequests, workflowRuns } from "@/server/db/schema";
import { apiUser, json } from "@/server/session";
import { evaluate, loadPolicyContext } from "@/server/approvals/policy";
import { enqueue } from "@/server/queues";
import { audit } from "@/server/audit";
import { publish } from "@/server/pubsub";

const Body = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(800).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(req);
  if (!user) return json({ error: "unauthorized", message: "Sign in to continue." }, 401);
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "Choose approve or reject." }, 400);

  const [row] = await db
    .select({ a: approvalRequests, repo: repositories, rr: runRequests })
    .from(approvalRequests)
    .innerJoin(workflowRuns, eq(approvalRequests.workflowRunId, workflowRuns.id))
    .innerJoin(repositories, eq(workflowRuns.repositoryId, repositories.id))
    .leftJoin(runRequests, eq(workflowRuns.runRequestId, runRequests.id))
    .where(eq(approvalRequests.id, id));
  if (!row) return json({ error: "not_found", message: "This approval no longer exists." }, 404);

  // Server-side check: the UI hides the buttons, but this is what enforces the rule.
  const elig = evaluate(await loadPolicyContext(), user, {
    repositoryId: row.repo.id,
    owner: row.repo.owner,
    environmentName: row.a.environmentName,
    reviewers: row.a.reviewers,
    requestedBy: row.rr?.requestedBy ?? null,
  });
  if (!elig.allowed) {
    await audit({ actorUserId: user.id, action: "approval.denied", resourceType: "approval", resourceId: id, data: { reason: elig.reason } });
    return json({ error: "forbidden", message: elig.reason }, 403);
  }

  const { decision, comment } = parsed.data;
  // Compare-and-swap: only one decision can win.
  const won = await db
    .update(approvalRequests)
    .set({ state: "deciding", decision, comment: comment?.trim() || null, decidedBy: user.id, decidedAt: new Date(), error: null, updatedAt: new Date() })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.state, "pending")))
    .returning({ id: approvalRequests.id });
  if (!won.length) return json({ error: "already_decided", message: "Someone already decided this, or GitHub closed it." }, 409);

  await audit({
    actorUserId: user.id,
    action: decision === "approve" ? "approval.approve_requested" : "approval.reject_requested",
    resourceType: "approval",
    resourceId: id,
    data: { environment: row.a.environmentName, comment: comment ?? null, mode: elig.mode },
  });
  await enqueue.approvalDecide(id);
  await publish("approvals", { id });
  if (row.rr) await publish(`run-${row.rr.id}`, { approval: id });
  return json({ ok: true }, 202);
}

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { runRequests, workflowRuns } from "@/server/db/schema";
import { apiUser, json } from "@/server/session";
import { enqueue } from "@/server/queues";
import { audit } from "@/server/audit";
import { isTerminal } from "@/lib/phases";

const Body = z.object({ action: z.enum(["cancel", "rerun", "rerun_failed", "rerun_debug"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(req);
  if (!user) return json({ error: "unauthorized", message: "Sign in to continue." }, 401);
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "Unknown action." }, 400);
  const { action } = parsed.data;

  const [row] = await db
    .select({ rr: runRequests, run: workflowRuns })
    .from(runRequests)
    .leftJoin(workflowRuns, eq(workflowRuns.runRequestId, runRequests.id))
    .where(eq(runRequests.id, id));
  if (!row) return json({ error: "not_found", message: "Run not found." }, 404);
  if (!row.run) return json({ error: "not_started", message: "This run hasn't started on GitHub yet." }, 409);
  if (user.role !== "admin" && row.rr.requestedBy !== user.id) {
    return json({ error: "forbidden", message: "Only the person who started this run or an admin can do that." }, 403);
  }
  const terminal = isTerminal(row.run.phase);
  if (action === "cancel" && terminal) return json({ error: "finished", message: "This run has already finished." }, 409);
  if (action !== "cancel" && !terminal) return json({ error: "running", message: "Wait for the run to finish before rerunning it." }, 409);

  await audit({ actorUserId: user.id, action: `run.${action}.requested`, resourceType: "run", resourceId: id });
  await enqueue.runAction(id, action, user.id);
  return json({ ok: true }, 202);
}

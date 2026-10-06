import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { repositories, runRequests, workflowRuns, workflowVersions, workflows } from "@/server/db/schema";

export async function loadRunRequest(id: string) {
  const [row] = await db
    .select({ rr: runRequests, wf: workflows, repo: repositories })
    .from(runRequests)
    .innerJoin(workflows, eq(runRequests.workflowId, workflows.id))
    .innerJoin(repositories, eq(workflows.repositoryId, repositories.id))
    .where(eq(runRequests.id, id));
  if (!row) return null;
  const versionId = row.rr.workflowVersionId ?? row.wf.currentVersionId;
  const [version] = versionId ? await db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId)) : [];
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.runRequestId, id));
  return { ...row, version: version ?? null, run: run ?? null };
}

export function log(scope: string, message: string, extra?: Record<string, unknown>) {
  console.log(`${new Date().toISOString()} [${scope}] ${message}${extra ? " " + JSON.stringify(extra) : ""}`);
}

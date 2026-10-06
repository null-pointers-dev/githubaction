import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { repositories, runRequests, workflowVersions, workflows } from "./db/schema";
import { REQUESTED_BY_INPUT, validateInputs, type InputValues } from "@/lib/inputs";
import { audit } from "./audit";
import { enqueue } from "./queues";
import { publish } from "./pubsub";
import type { AppUser } from "./session";

export type CreateRunBody = {
  workflowId: string;
  ref: string;
  inputs: InputValues;
  schemaVersion: string;
  idempotencyKey: string;
};

export type CreateRunResult =
  | { status: 201 | 200; body: { id: string } }
  | { status: 400 | 404 | 409; body: { error: string; message: string; errors?: Record<string, string> } };

export async function createRunRequest(user: AppUser, body: CreateRunBody): Promise<CreateRunResult> {
  const [row] = await db
    .select({ wf: workflows, repo: repositories, version: workflowVersions })
    .from(workflows)
    .innerJoin(repositories, eq(workflows.repositoryId, repositories.id))
    .leftJoin(workflowVersions, eq(workflows.currentVersionId, workflowVersions.id))
    .where(eq(workflows.id, body.workflowId));

  if (!row) return { status: 404, body: { error: "not_found", message: "This workflow no longer exists." } };
  const { wf, repo, version } = row;
  if (!wf.dispatchable || !version) {
    return { status: 400, body: { error: "not_dispatchable", message: "This workflow can't be started manually." } };
  }
  if (wf.state !== "active") {
    return { status: 400, body: { error: "disabled", message: "This workflow is disabled on GitHub." } };
  }
  if (version.id !== body.schemaVersion) {
    return {
      status: 409,
      body: { error: "schema_changed", message: "The workflow's inputs changed since you opened the form. Reload to see them." },
    };
  }
  const ref = body.ref.trim() || repo.defaultBranch;

  const result = validateInputs(version.inputs, body.inputs);
  if (!result.ok) {
    return { status: 400, body: { error: "invalid_inputs", message: "Some inputs need attention.", errors: result.errors } };
  }
  const inputs = { ...result.serialized };
  if (version.inputs.some((f) => f.key === REQUESTED_BY_INPUT)) inputs[REQUESTED_BY_INPUT] = user.email;

  const inserted = await db
    .insert(runRequests)
    .values({
      workflowId: wf.id,
      workflowVersionId: version.id,
      source: "flowdeck",
      ref,
      inputs,
      requestedBy: user.id,
      idempotencyKey: body.idempotencyKey,
      phase: "pending",
    })
    .onConflictDoNothing({ target: [runRequests.requestedBy, runRequests.idempotencyKey] })
    .returning({ id: runRequests.id });

  if (inserted.length === 0) {
    // Same request submitted twice: return the original.
    const [existing] = await db
      .select({ id: runRequests.id })
      .from(runRequests)
      .where(and(eq(runRequests.requestedBy, user.id), eq(runRequests.idempotencyKey, body.idempotencyKey)));
    return { status: 200, body: { id: existing.id } };
  }

  const id = inserted[0].id;
  const sensitive = new Set(version.inputs.filter((f) => f.sensitive).map((f) => f.key));
  await audit({
    actorUserId: user.id,
    action: "run.requested",
    resourceType: "run",
    resourceId: id,
    data: {
      workflow: `${repo.fullName}/${wf.path}`,
      ref,
      inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, sensitive.has(k) ? "[masked]" : v])),
    },
  });
  await enqueue.dispatch(id);
  await publish("runs", { id });
  return { status: 201, body: { id } };
}

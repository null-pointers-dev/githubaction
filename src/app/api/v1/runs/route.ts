import { z } from "zod";
import { apiUser, json } from "@/server/session";
import { createRunRequest } from "@/server/runs";
import { listRuns, type RunsFilter } from "@/server/views";

const Body = z.object({
  workflowId: z.string().uuid(),
  ref: z.string().max(255),
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  schemaVersion: z.string().min(1),
  idempotencyKey: z.string().min(8).max(100),
});

export async function POST(req: Request) {
  const user = await apiUser(req);
  if (!user) return json({ error: "unauthorized", message: "Sign in to continue." }, 401);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "The request was malformed." }, 400);
  const result = await createRunRequest(user, parsed.data);
  return json(result.body, result.status);
}

export async function GET(req: Request) {
  const user = await apiUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const filter = (new URL(req.url).searchParams.get("filter") ?? "all") as RunsFilter;
  return json(await listRuns(user.id, filter));
}

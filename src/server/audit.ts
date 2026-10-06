import { db } from "./db";
import { auditEvents } from "./db/schema";

export async function audit(event: {
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  data?: Record<string, unknown>;
}) {
  await db.insert(auditEvents).values({
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    data: event.data ?? {},
  });
}

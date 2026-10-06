import { eq } from "drizzle-orm";
import { db } from "./db";
import { appSettings, type ApprovalMode } from "./db/schema";

export type ApprovalDefaults = { mode: ApprovalMode; preventSelfApproval: boolean };

const DEFAULT_APPROVALS: ApprovalDefaults = { mode: "github", preventSelfApproval: true };

export async function getApprovalDefaults(): Promise<ApprovalDefaults> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "approvals"));
  return { ...DEFAULT_APPROVALS, ...((row?.value as Partial<ApprovalDefaults>) ?? {}) };
}

export async function setApprovalDefaults(value: ApprovalDefaults) {
  await db
    .insert(appSettings)
    .values({ key: "approvals", value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

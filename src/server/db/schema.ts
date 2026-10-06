import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { InputField } from "@/lib/inputs";
import type { JobMeta } from "@/lib/graph";

/* ------------------------------------------------------------------ */
/* Better Auth core tables (field names must match Better Auth).       */
/* ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // FlowDeck additions (declared as additionalFields in auth.ts)
  role: text("role").notNull().default("member"), // "admin" | "member"
  githubLogin: text("github_login"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* GitHub connections                                                  */
/* ------------------------------------------------------------------ */

export type CredentialKind = "pat" | "app";
/** dispatch: sync, trigger, cancel, rerun, read runs. approver: approve/reject deployments. */
export type CredentialPurpose = "dispatch" | "approver";
export type CredentialStatus = "verifying" | "healthy" | "expiring" | "error";

export const githubCredentials = pgTable(
  "github_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** GitHub organisation or user login this credential serves. */
    owner: text("owner").notNull(),
    kind: text("kind").$type<CredentialKind>().notNull(),
    purpose: text("purpose").$type<CredentialPurpose>().notNull(),
    /** AES-GCM encrypted JSON: { token } for PATs, { privateKey } for Apps. */
    encryptedSecret: text("encrypted_secret").notNull(),
    appId: text("app_id"),
    installationId: text("installation_id"),
    /** Identity GitHub sees for this credential, e.g. "release-approver" or "flowdeck[bot]". */
    tokenLogin: text("token_login"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").$type<CredentialStatus>().notNull().default("verifying"),
    lastError: text("last_error"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("github_credentials_owner_purpose").on(t.owner, t.purpose)],
);

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export type RepoEnvironment = {
  id: number;
  name: string;
  /** True when GitHub requires reviewers for this environment. */
  protected: boolean;
  reviewers: Reviewer[];
  preventSelfReview: boolean;
};

export type Reviewer =
  | { type: "User"; login: string }
  | { type: "Team"; slug: string; name?: string; org: string };

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    private: boolean("private").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    environments: jsonb("environments").$type<RepoEnvironment[]>().notNull().default([]),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("repositories_owner").on(t.owner)],
);

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    githubWorkflowId: bigint("github_workflow_id", { mode: "number" }).notNull().unique(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    /** GitHub state ("active", "disabled_manually", ...) or "deleted". */
    state: text("state").notNull(),
    dispatchable: boolean("dispatchable").notNull().default(false),
    currentVersionId: uuid("current_version_id"),
    description: text("description"),
    ownerTeam: text("owner_team"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    htmlUrl: text("html_url"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflows_repository").on(t.repositoryId)],
);

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** Git blob SHA of the workflow file. */
    blobSha: text("blob_sha").notNull(),
    /** Git blob SHA of the optional .github/flowdeck/<file> sidecar. */
    sidecarSha: text("sidecar_sha").notNull().default(""),
    ref: text("ref").notNull(),
    inputs: jsonb("inputs").$type<InputField[]>().notNull().default([]),
    jobs: jsonb("jobs").$type<JobMeta[]>().notNull().default([]),
    concurrency: jsonb("concurrency").$type<{ group: string; cancelInProgress: boolean } | null>(),
    parseError: text("parse_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workflow_versions_key").on(t.workflowId, t.blobSha, t.sidecarSha)],
);

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

export const runRequests = pgTable(
  "run_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workflowVersionId: uuid("workflow_version_id"),
    /** "flowdeck" when started here, "github" when observed from elsewhere. */
    source: text("source").notNull().default("flowdeck"),
    ref: text("ref").notNull(),
    inputs: jsonb("inputs").$type<Record<string, string>>().notNull().default({}),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    phase: text("phase").notNull().default("pending"),
    githubRunId: bigint("github_run_id", { mode: "number" }),
    htmlUrl: text("html_url"),
    actorLogin: text("actor_login"),
    error: text("error"),
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    resourceVersion: integer("resource_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("run_requests_idempotency").on(t.requestedBy, t.idempotencyKey),
    index("run_requests_workflow_created").on(t.workflowId, t.createdAt),
    index("run_requests_phase").on(t.phase),
    index("run_requests_github_run").on(t.githubRunId),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runRequestId: uuid("run_request_id").references(() => runRequests.id, { onDelete: "set null" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    githubRunId: bigint("github_run_id", { mode: "number" }).notNull().unique(),
    runAttempt: integer("run_attempt").notNull().default(1),
    runNumber: integer("run_number"),
    displayTitle: text("display_title"),
    event: text("event"),
    status: text("status"),
    conclusion: text("conclusion"),
    phase: text("phase").notNull().default("queued"),
    headBranch: text("head_branch"),
    headSha: text("head_sha"),
    actorLogin: text("actor_login"),
    htmlUrl: text("html_url"),
    etag: text("etag"),
    jobsEtag: text("jobs_etag"),
    notFoundCount: integer("not_found_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    githubUpdatedAt: timestamp("github_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
    resourceVersion: integer("resource_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_runs_phase").on(t.phase), index("workflow_runs_request").on(t.runRequestId)],
);

export type JobStep = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export const workflowJobs = pgTable(
  "workflow_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowRunId: uuid("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    githubJobId: bigint("github_job_id", { mode: "number" }).notNull().unique(),
    runAttempt: integer("run_attempt").notNull().default(1),
    name: text("name").notNull(),
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    runnerName: text("runner_name"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    steps: jsonb("steps").$type<JobStep[]>().notNull().default([]),
    htmlUrl: text("html_url"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_jobs_run").on(t.workflowRunId, t.runAttempt)],
);

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/**
 * pending  - waiting for a decision
 * deciding - a FlowDeck user decided; the worker is sending it to GitHub
 * approved / rejected - GitHub accepted the decision made in FlowDeck
 * closed   - GitHub no longer waits (decided on GitHub, timer, cancelled run)
 */
export type ApprovalState = "pending" | "deciding" | "approved" | "rejected" | "closed";

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowRunId: uuid("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    githubRunId: bigint("github_run_id", { mode: "number" }).notNull(),
    runAttempt: integer("run_attempt").notNull(),
    environmentId: bigint("environment_id", { mode: "number" }).notNull(),
    environmentName: text("environment_name").notNull(),
    reviewers: jsonb("reviewers").$type<Reviewer[]>().notNull().default([]),
    /** Whether GitHub says the approver token's account may approve this gate. */
    approverTokenCanApprove: boolean("approver_token_can_approve"),
    waitTimerMinutes: integer("wait_timer_minutes"),
    state: text("state").$type<ApprovalState>().notNull().default("pending"),
    decision: text("decision").$type<"approve" | "reject">(),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
    error: text("error"),
    githubSyncedAt: timestamp("github_synced_at", { withTimezone: true }),
    resourceVersion: integer("resource_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("approval_requests_gate").on(t.githubRunId, t.runAttempt, t.environmentId),
    index("approval_requests_state").on(t.state),
  ],
);

export type ApprovalMode = "github" | "flowdeck";

/**
 * Who may approve a protected environment.
 * Matching order: repo + exact env, repo + "*", any repo + exact env, any repo + "*",
 * then the global default in app_settings.
 */
export const approvalPolicies = pgTable("approval_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
  environmentName: text("environment_name").notNull().default("*"),
  mode: text("mode").$type<ApprovalMode>().notNull(),
  approverUserIds: jsonb("approver_user_ids").$type<string[]>().notNull().default([]),
  approverRoles: jsonb("approver_roles").$type<string[]>().notNull().default([]),
  preventSelfApproval: boolean("prevent_self_approval").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cached members of GitHub teams listed as environment reviewers. */
export const githubTeamMembers = pgTable(
  "github_team_members",
  {
    org: text("org").notNull(),
    teamSlug: text("team_slug").notNull(),
    login: text("login").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("github_team_members_pk").on(t.org, t.teamSlug, t.login)],
);

/* ------------------------------------------------------------------ */
/* Infrastructure                                                      */
/* ------------------------------------------------------------------ */

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookInbox = pgTable(
  "webhook_inbox",
  {
    deliveryId: text("delivery_id").primaryKey(),
    event: text("event").notNull(),
    action: text("action"),
    installationId: bigint("installation_id", { mode: "number" }),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [index("webhook_inbox_received").on(t.receivedAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_events_created").on(t.createdAt)],
);

# FlowDeck

A control plane for GitHub Actions: a catalog of runnable workflows, validated input forms, live run tracking, cancel and rerun, and deployment approvals that only reach the people allowed to give them. Every action is recorded against the FlowDeck user who took it.

Built with Next.js 16.3, React 19.3, Better Auth 1.7, BullMQ 6.3, Drizzle ORM 0.45 and Postgres.

> **Status:** written without being able to install packages or run it, so the first `npm install` / `npm run build` may surface a few type errors or small API mismatches. They should be quick to fix; the structure and logic are complete.

## How it works

```
Browser ──HTTPS──▶ Next.js app ──rows──▶ Postgres (source of truth)
   ▲                 │  webhook route ──jobs──▶ Redis (BullMQ, locks, pub/sub)
   └──── SSE ◀───────┘                              │
                                                    ▼
GitHub ◀──── every API call ──── Worker (BullMQ processors + 60-second poller)
```

- The **Next.js app** only writes rows and adds jobs. It never calls GitHub (except reading your GitHub username at sign-in).
- The **worker** (`npm run worker`) is the only process that calls GitHub or changes run status.
- **Webhooks are hints, not truth.** Each event just queues a reconcile of that run; the reconcile reads the run from GitHub and merges it.
- A **poller runs every 60 seconds** and re-checks every run that hasn't finished, whether or not webhooks work. Unchanged runs cost nothing (ETag, 304 responses don't count against the rate limit).

### Race conditions handled

| Situation | Prevention |
| --- | --- |
| Double-click or client retry | `Idempotency-Key` per form; unique `(user, key)` index |
| Two workers dispatch the same request | Claim with `UPDATE … WHERE phase = 'pending'` |
| GitHub times out after creating the run | Phase `unknown`: search for the run before ever retrying |
| Webhook arrives before the dispatch response | Placeholder record adopted by run ID |
| Out-of-order webhooks | Phases only move forward within an attempt |
| Webhook and poller update the same run | BullMQ deduplication + Redis lock per run + version bump |
| Two approvers decide at once | Compare-and-swap `pending → deciding`; one wins |
| Worker dies mid-approval | Poller re-sends decisions stuck in `deciding` |

## Approvals

GitHub only lets a **required reviewer** approve a pending deployment, and FlowDeck talks to GitHub with tokens, not as each person. So:

1. **Every approval is sent to GitHub with the approver token** for that organisation (Settings → Connections → "Approving deployments"). That token must belong to an account listed as a required reviewer on the protected environments.
2. **FlowDeck decides who may press Approve**, per environment, with a toggle (Settings → Approvals):
   - **Mirror GitHub** (default): a person can approve if their linked GitHub username is a required reviewer, directly or via a team. Usernames come from "Sign in with GitHub" or are set by an admin under People.
   - **FlowDeck approvers**: you choose people and/or roles per repository and environment.
   - Rules can be global, per environment, per repository, or per repository and environment; the most specific wins.
3. A pending approval **only appears for people who can approve it**: in the Approvals inbox, the nav badge, the catalog's "Waiting on you" panel and the Approve button on the run page. Everyone else sees "waiting for approval" with the reviewers listed. The API re-checks eligibility on every decision and refuses anyone else.
4. FlowDeck records who approved or rejected (audit log and the run page), and the GitHub comment reads `Approved by Priya Raman <priya@acme.com> in FlowDeck: …`.

**Use a different account for the approver token than for the runs connection.** If an environment has "Prevent self-review" on, GitHub refuses an approval from the same identity that started the run.

## Setup

Requirements: Node.js 22.12+, Docker (for Postgres and Redis).

```bash
cp .env.example .env               # fill in the secrets (see comments in the file)
docker compose up -d postgres redis
npm install
npm run db:push                    # create tables (or db:generate + db:migrate)
npm run dev                        # http://localhost:3000
npm run worker:dev                 # in a second terminal
```

1. Open http://localhost:3000/sign-up. **The first account becomes the administrator.**
2. Settings → Connections → add a **runs connection** for your GitHub organisation (fine-grained PAT or GitHub App). FlowDeck checks it and syncs every workflow that has a `workflow_dispatch` trigger.
3. Add an **approver token** for the same organisation (PAT of a reviewer account).
4. Point a GitHub webhook at `https://<your-host>/api/webhooks/github`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`. Events: Workflow runs, Workflow jobs, Deployment reviews, Deployment statuses, Pushes, Repositories (plus Installation events for a GitHub App). Locally, use a tunnel such as `cloudflared` or `smee`. Without webhooks everything still works, updated by the minute check.

### Token permissions

| Connection | Fine-grained PAT permissions |
| --- | --- |
| Runs (sync, dispatch, cancel, rerun) | Repository: Actions read/write, Contents read, Deployments read, Environments read, Metadata read. Organisation: Members read (only if teams are environment reviewers). |
| Approver | Repository: Actions read, Deployments read/write. The account must be a required reviewer on the environments it approves. |

A GitHub App works for the runs connection (Actions R/W, Contents R, Deployments R, Environments R, Metadata R, Members R; subscribe to the events above). Apps can't be environment reviewers, so approvals always need a PAT.

### Production

```bash
docker compose --profile app up --build -d   # web + worker + Postgres + Redis
```

Run one or more `worker` containers; BullMQ schedulers guarantee one poller tick per minute regardless of replica count. Redis must use `maxmemory-policy noeviction`.

## Workflow sidecar (optional)

GitHub inputs only support string, boolean, choice, number and environment. Add `.github/flowdeck/<same file name>` next to a workflow for patterns, ranges, conditional fields and catalog metadata. See `examples/`. If a workflow declares an input named `flowdeck_requested_by`, FlowDeck fills it with the email of the person who started the run and hides it from the form.

## Project layout

```
src/app            Next.js pages, API routes (runs, approvals, SSE stream, webhook) and auth
src/components     Run form, live run view, transit-style progress map, nav
src/lib            Shared by browser and server: input validation, phases, job graph
src/server         Database schema, auth, queues, GitHub client, approval policy, read models
src/worker         BullMQ processors: ingest, dispatch, reconcile, approval, sync, poller, maintenance
examples           A deploy workflow and its FlowDeck sidecar
```

## Known limits

- Live step logs: GitHub's API serves job logs after a job finishes; FlowDeck links to them and shows step progress while running.
- Sensitive inputs are masked in FlowDeck's UI and audit log but stored as plain JSON in Postgres so they can be sent to GitHub; GitHub may also show input values in its own UI.
- Webhook redelivery is automatic only for GitHub App webhooks; repo/org webhooks rely on the 60-second poller.
- Single tenant: one FlowDeck install per company. Roles are admin and member.

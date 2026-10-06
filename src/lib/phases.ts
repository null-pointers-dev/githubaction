/**
 * Run phases. A RunRequest starts in FlowDeck phases (pending, dispatching, unknown)
 * and then mirrors the GitHub run. Within one attempt, phases only move forward.
 */

export const PHASES = [
  "pending",
  "dispatching",
  "unknown",
  "dispatch_failed",
  "dispatched",
  "queued",
  "in_progress",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "completed",
  "lost",
] as const;

export type Phase = (typeof PHASES)[number];

export const TERMINAL_PHASES: Phase[] = [
  "dispatch_failed",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "completed",
  "lost",
];

/** Phases that belong to a GitHub run that has not finished. */
export const ACTIVE_RUN_PHASES: Phase[] = ["dispatched", "queued", "in_progress", "waiting"];

export function isTerminal(phase: string): boolean {
  return (TERMINAL_PHASES as string[]).includes(phase);
}

const RANK: Record<Phase, number> = {
  pending: 0,
  dispatching: 1,
  unknown: 1,
  dispatched: 2,
  queued: 3,
  in_progress: 4,
  waiting: 4,
  dispatch_failed: 9,
  succeeded: 9,
  failed: 9,
  cancelled: 9,
  timed_out: 9,
  completed: 9,
  lost: 9,
};

export function rank(phase: string): number {
  return RANK[phase as Phase] ?? 0;
}

export function phaseFromGitHub(status: string | null | undefined, conclusion: string | null | undefined): Phase {
  switch (status) {
    case "completed":
      switch (conclusion) {
        case "success":
          return "succeeded";
        case "failure":
        case "startup_failure":
          return "failed";
        case "cancelled":
          return "cancelled";
        case "timed_out":
          return "timed_out";
        default:
          return "completed";
      }
    case "in_progress":
      return "in_progress";
    case "waiting":
      return "waiting";
    default:
      // requested, queued, pending
      return "queued";
  }
}

export const PHASE_LABEL: Record<Phase, string> = {
  pending: "Starting",
  dispatching: "Starting",
  unknown: "Confirming with GitHub",
  dispatch_failed: "Couldn't start",
  dispatched: "Started",
  queued: "Queued",
  in_progress: "Running",
  waiting: "Waiting for approval",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  completed: "Completed",
  lost: "Not found on GitHub",
};

export type Tone = "ok" | "fail" | "run" | "wait" | "idle";

export function phaseTone(phase: string): Tone {
  switch (phase) {
    case "succeeded":
      return "ok";
    case "failed":
    case "dispatch_failed":
    case "timed_out":
    case "lost":
      return "fail";
    case "waiting":
      return "wait";
    case "in_progress":
    case "dispatched":
    case "dispatching":
    case "pending":
    case "unknown":
      return "run";
    default:
      return "idle";
  }
}

export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase as Phase] ?? phase;
}

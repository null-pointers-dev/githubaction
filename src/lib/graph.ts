/** Job graph for the progress map, built from the workflow YAML plus live job data. */

export type JobMeta = {
  /** YAML job id, e.g. "deploy_prod". */
  id: string;
  /** Job "name:" or the id. May contain ${{ }} expressions. */
  name: string;
  needs: string[];
  /** Environment name or expression, if the job targets one. */
  environment?: string;
};

export type LiveJob = {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type NodeStatus = "done" | "failed" | "running" | "waiting" | "todo" | "skipped";

export type GraphNode = {
  key: string;
  label: string;
  status: NodeStatus;
  level: number;
  needs: string[];
  durationMs: number | null;
  count: number;
};

function jobStatus(j: LiveJob): NodeStatus {
  if (j.status === "completed") {
    if (j.conclusion === "success") return "done";
    if (j.conclusion === "skipped" || j.conclusion === "neutral") return "skipped";
    if (j.conclusion === "cancelled") return "skipped";
    return "failed";
  }
  if (j.status === "waiting") return "waiting";
  if (j.status === "in_progress") return "running";
  return "todo";
}

function combine(statuses: NodeStatus[]): NodeStatus {
  if (statuses.length === 0) return "todo";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.includes("running")) return "running";
  if (statuses.every((s) => s === "done" || s === "skipped")) return statuses.includes("done") ? "done" : "skipped";
  if (statuses.some((s) => s === "done")) return "running";
  return "todo";
}

function hasExpression(s: string) {
  return s.includes("${{");
}

/** Matches a live job (e.g. "Build (ubuntu, 22)") to a YAML job. */
function matches(meta: JobMeta, live: LiveJob): boolean {
  const n = live.name;
  if (n === meta.id) return true;
  if (!hasExpression(meta.name)) {
    if (n === meta.name) return true;
    if (n.startsWith(`${meta.name} (`)) return true;
  }
  if (n.startsWith(`${meta.id} (`)) return true;
  return false;
}

function duration(jobs: LiveJob[]): number | null {
  const starts = jobs.map((j) => (j.startedAt ? Date.parse(j.startedAt) : NaN)).filter(Number.isFinite);
  const ends = jobs.map((j) => (j.completedAt ? Date.parse(j.completedAt) : NaN)).filter(Number.isFinite);
  if (!starts.length || ends.length !== jobs.length) return null;
  return Math.max(...ends) - Math.min(...starts);
}

export function buildGraph(meta: JobMeta[], live: LiveJob[]): GraphNode[] {
  const used = new Set<LiveJob>();
  const nodes: GraphNode[] = [];

  if (meta.length > 0) {
    const byId = new Map(meta.map((m) => [m.id, m]));
    const levelCache = new Map<string, number>();
    const level = (id: string, seen = new Set<string>()): number => {
      if (levelCache.has(id)) return levelCache.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const m = byId.get(id);
      const l = !m || m.needs.length === 0 ? 0 : 1 + Math.max(...m.needs.map((n) => level(n, seen)));
      levelCache.set(id, l);
      return l;
    };

    for (const m of meta) {
      const mine = live.filter((j) => !used.has(j) && matches(m, j));
      mine.forEach((j) => used.add(j));
      const label = hasExpression(m.name) ? m.id : m.name;
      nodes.push({
        key: m.id,
        label: mine.length > 1 ? `${label} (${mine.length})` : mine[0]?.name ?? label,
        status: combine(mine.map(jobStatus)),
        level: level(m.id),
        needs: m.needs.filter((n) => byId.has(n)),
        durationMs: mine.length ? duration(mine) : null,
        count: mine.length,
      });
    }
  }

  // Jobs we could not match (dynamic names, reusable workflows): place them by start order.
  const rest = live.filter((j) => !used.has(j));
  if (rest.length) {
    const base = nodes.length ? Math.max(...nodes.map((n) => n.level)) + 1 : 0;
    const sorted = [...rest].sort((a, b) => (a.startedAt ?? "9").localeCompare(b.startedAt ?? "9"));
    sorted.forEach((j, i) => {
      const prev = i === 0 ? null : `live-${i - 1}`;
      nodes.push({
        key: `live-${i}`,
        label: j.name,
        status: jobStatus(j),
        level: meta.length ? base : i,
        needs: meta.length ? [] : prev ? [prev] : [],
        durationMs: duration([j]),
        count: 1,
      });
    });
  }
  return nodes;
}

/** Environment a job targets. Expressions such as ${{ inputs.environment }} are resolved with the run's inputs. */
export function resolveEnvironment(expr: string | undefined, inputs: Record<string, string | number | boolean | undefined>): string | null {
  if (!expr) return null;
  const m = expr.match(/^\$\{\{\s*(?:inputs|github\.event\.inputs)\.([A-Za-z0-9_-]+)\s*\}\}$/);
  if (m) {
    const v = inputs[m[1]];
    return v === undefined || v === "" ? null : String(v);
  }
  return expr.includes("${{") ? null : expr;
}

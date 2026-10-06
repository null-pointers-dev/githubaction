import { buildGraph, type GraphNode, type JobMeta, type LiveJob } from "@/lib/graph";
import { formatDuration } from "@/lib/format";

const ROW = 52;
const PAD_X = 70;
const SINGLE_COL = 190;
const MULTI_COL = 300;
const TOP = 46;

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function subLabel(n: GraphNode) {
  if (n.status === "waiting") return "Waiting for approval";
  if (n.status === "running") return "Running";
  if (n.status === "failed") return n.durationMs ? `Failed after ${formatDuration(n.durationMs)}` : "Failed";
  if (n.status === "skipped") return "Skipped";
  if (n.status === "todo") return "Not started";
  return formatDuration(n.durationMs);
}

/** Compact status for stations stacked in a parallel column. */
function shortSub(n: GraphNode) {
  if (n.status === "failed") return "failed";
  if (n.status === "waiting") return "waiting";
  if (n.status === "running") return "running";
  if (n.status === "skipped") return "skipped";
  if (n.status === "todo") return "";
  return formatDuration(n.durationMs);
}

/** Jobs drawn as stations on a line; parallel jobs branch off and rejoin. */
export function TransitMap({ meta, jobs }: { meta: JobMeta[]; jobs: LiveJob[] }) {
  const nodes = buildGraph(meta, jobs);
  if (nodes.length === 0) {
    return <p className="muted" style={{ padding: "8px 0 4px" }}>Jobs appear here as soon as GitHub starts the run.</p>;
  }

  const levels = [...new Set(nodes.map((n) => n.level))].sort((a, b) => a - b);
  const columns = levels.map((l) => nodes.filter((n) => n.level === l));
  const maxRows = Math.max(...columns.map((c) => c.length));
  const half = ((maxRows - 1) / 2) * ROW;
  const mid = TOP + half;
  const height = Math.max(mid + half + 26, mid + 66);

  const pos = new Map<string, { x: number; y: number; multi: boolean }>();
  let x = PAD_X;
  columns.forEach((col, i) => {
    const multi = col.length > 1;
    col.forEach((n, j) => pos.set(n.key, { x, y: mid + (j - (col.length - 1) / 2) * ROW, multi }));
    x += i < columns.length - 1 ? (multi ? MULTI_COL : SINGLE_COL) : 0;
  });
  const width = x + PAD_X + 60;
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  const edges: Array<{ d: string; cls: string; key: string }> = [];
  for (const n of nodes) {
    const to = pos.get(n.key)!;
    for (const need of n.needs) {
      const from = pos.get(need);
      const src = byKey.get(need);
      if (!from || !src) continue;
      // Split right after a single station; merge right before a single station.
      const start = from.multi && !to.multi ? to.x - 60 : from.x;
      const curveEnd = start + 60;
      const d = from.y === to.y
        ? `M${from.x} ${from.y}H${to.x}`
        : `M${from.x} ${from.y}H${start}C${start + 30} ${from.y} ${start + 30} ${to.y} ${curveEnd} ${to.y}H${to.x}`;
      const cls = src.status === "done" || src.status === "skipped" ? "ln-done" : src.status === "failed" ? "ln-fail" : "ln-todo";
      edges.push({ d, cls, key: `${need}-${n.key}` });
    }
  }
  // Draw pending edges first so finished track sits on top.
  edges.sort((a, b) => (a.cls === "ln-todo" ? -1 : 0) - (b.cls === "ln-todo" ? -1 : 0));

  const summary = nodes.map((n) => `${n.label}: ${subLabel(n) || "done"}`).join(". ");

  return (
    <div className="track-scroll">
      <svg className="track" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
        {edges.map((e) => (
          <path key={e.key} className={`ln ${e.cls}`} d={e.d} />
        ))}
        {nodes.map((n) => {
          const p = pos.get(n.key)!;
          const r = p.multi ? 10 : 12;
          const label = truncate(n.label, p.multi ? 24 : 22);
          const sub = p.multi ? shortSub(n) : subLabel(n);
          const textCls = n.status === "waiting" ? "t-waiting" : n.status === "failed" ? "t-failed" : "";
          return (
            <g key={n.key}>
              {(n.status === "waiting" || n.status === "running") && (
                <circle className={`ring ring-${n.status}`} cx={p.x} cy={p.y} r={r + 5} />
              )}
              {n.status === "waiting" ? (
                <rect className="st-waiting" x={p.x - 11} y={p.y - 11} width={22} height={22} rx={4} transform={`rotate(45 ${p.x} ${p.y})`} />
              ) : (
                <circle className={`st-${n.status}`} cx={p.x} cy={p.y} r={r} />
              )}
              {n.status === "done" && <path className="glyph" d={`M${p.x - 5} ${p.y + 0.5}l3.3 3.3 6.2-6.6`} />}
              {n.status === "failed" && <path className="glyph" d={`M${p.x - 4} ${p.y - 4}l8 8M${p.x + 4} ${p.y - 4}l-8 8`} />}
              {p.multi ? (
                <text x={p.x + 16} y={p.y - 10} className={textCls}>
                  {label} <tspan className="sub">{sub}</tspan>
                </text>
              ) : (
                <>
                  <text x={p.x} y={p.y + 36} textAnchor="middle" className={textCls}>
                    {label}
                  </text>
                  <text x={p.x} y={p.y + 53} textAnchor="middle" className="sub">
                    {sub}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

import { parse } from "yaml";
import { MAX_INPUTS, type InputField, type InputType } from "@/lib/inputs";
import type { JobMeta } from "@/lib/graph";

export type ParsedWorkflow = {
  name?: string;
  dispatchable: boolean;
  inputs: InputField[];
  jobs: JobMeta[];
  concurrency: { group: string; cancelInProgress: boolean } | null;
  catalog: { description?: string; owner?: string; tags?: string[] };
  error?: string;
};

const INPUT_TYPES: InputType[] = ["string", "boolean", "choice", "number", "environment"];

function humanize(key: string) {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function dispatchConfig(on: unknown): { present: boolean; inputs: Record<string, unknown> } {
  if (typeof on === "string") return { present: on === "workflow_dispatch", inputs: {} };
  if (Array.isArray(on)) return { present: on.includes("workflow_dispatch"), inputs: {} };
  const rec = asRecord(on);
  if (!("workflow_dispatch" in rec)) return { present: false, inputs: {} };
  return { present: true, inputs: asRecord(asRecord(rec.workflow_dispatch).inputs) };
}

function readDefault(type: InputType, v: unknown): string | number | boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (type === "boolean") return v === true || v === "true";
  if (type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return String(v);
}

/**
 * Parses a workflow file, optionally merged with a FlowDeck sidecar file
 * (.github/flowdeck/<same file name>) that adds validation and catalog metadata:
 *
 *   catalog: { description: "...", owner: "Payments platform", tags: [deploy] }
 *   inputs:
 *     version: { label: Version, pattern: "^\\d+\\.\\d+\\.\\d+$", patternMessage: "Use a full version like 2.14.0." }
 *     canary_percent: { min: 1, max: 50, visibleWhen: { input: canary, equals: "true" } }
 */
export function parseWorkflow(text: string, sidecarText?: string | null): ParsedWorkflow {
  let doc: Record<string, unknown>;
  try {
    doc = asRecord(parse(text));
  } catch (e) {
    return {
      dispatchable: false,
      inputs: [],
      jobs: [],
      concurrency: null,
      catalog: {},
      error: `Could not read the workflow file: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let sidecar: Record<string, unknown> = {};
  let sidecarError: string | undefined;
  if (sidecarText) {
    try {
      sidecar = asRecord(parse(sidecarText));
    } catch (e) {
      sidecarError = `Could not read the FlowDeck sidecar file: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const extra = asRecord(sidecar.inputs);

  // YAML 1.1 parsers read the key "on" as boolean true; handle both.
  const on = doc.on ?? (doc as Record<string, unknown>)["true"];
  const dispatch = dispatchConfig(on);

  const inputs: InputField[] = Object.entries(dispatch.inputs).map(([key, raw]) => {
    const def = asRecord(raw);
    const type = (INPUT_TYPES.includes(def.type as InputType) ? def.type : "string") as InputType;
    const ext = asRecord(extra[key]);
    const field: InputField = {
      key,
      type,
      label: typeof ext.label === "string" ? ext.label : humanize(key),
      description: typeof def.description === "string" ? def.description : undefined,
      required: def.required === true || def.required === "true",
      default: readDefault(type, def.default),
      options: Array.isArray(def.options) ? def.options.map(String) : undefined,
    };
    if (typeof ext.pattern === "string") field.pattern = ext.pattern;
    if (typeof ext.patternMessage === "string") field.patternMessage = ext.patternMessage;
    if (typeof ext.min === "number") field.min = ext.min;
    if (typeof ext.max === "number") field.max = ext.max;
    if (typeof ext.help === "string") field.help = ext.help;
    if (typeof ext.group === "string") field.group = ext.group;
    if (ext.hidden === true) field.hidden = true;
    if (ext.sensitive === true) field.sensitive = true;
    const vw = asRecord(ext.visibleWhen);
    if (typeof vw.input === "string" && vw.equals !== undefined) field.visibleWhen = { input: vw.input, equals: String(vw.equals) };
    if (key === "flowdeck_requested_by") field.hidden = true;
    return field;
  });

  const jobs: JobMeta[] = Object.entries(asRecord(doc.jobs)).map(([id, raw]) => {
    const job = asRecord(raw);
    const needs = typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs.map(String) : [];
    const env = job.environment;
    const environment = typeof env === "string" ? env : typeof asRecord(env).name === "string" ? String(asRecord(env).name) : undefined;
    return { id, name: typeof job.name === "string" ? job.name : id, needs, environment };
  });

  let concurrency: ParsedWorkflow["concurrency"] = null;
  if (typeof doc.concurrency === "string") concurrency = { group: doc.concurrency, cancelInProgress: false };
  else if (doc.concurrency && typeof asRecord(doc.concurrency).group === "string") {
    const c = asRecord(doc.concurrency);
    concurrency = { group: String(c.group), cancelInProgress: c["cancel-in-progress"] === true };
  }

  const cat = asRecord(sidecar.catalog);
  const errors = [sidecarError, inputs.length > MAX_INPUTS ? `GitHub allows at most ${MAX_INPUTS} inputs; this workflow declares ${inputs.length}.` : undefined].filter(Boolean);

  return {
    name: typeof doc.name === "string" ? doc.name : undefined,
    dispatchable: dispatch.present,
    inputs,
    jobs,
    concurrency,
    catalog: {
      description: typeof cat.description === "string" ? cat.description : undefined,
      owner: typeof cat.owner === "string" ? cat.owner : undefined,
      tags: Array.isArray(cat.tags) ? cat.tags.map(String) : undefined,
    },
    error: errors.length ? errors.join(" ") : undefined,
  };
}

export { resolveEnvironment } from "@/lib/graph";

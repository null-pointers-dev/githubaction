"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { defaultValues, isVisible, validateInputs, type InputField, type InputValues } from "@/lib/inputs";
import { resolveEnvironment, type JobMeta } from "@/lib/graph";
import { Shield } from "./icons";

type Env = { name: string; protected: boolean; approvers: string };

export function RunForm(props: {
  workflowId: string;
  versionId: string;
  defaultBranch: string;
  fields: InputField[];
  jobs: JobMeta[];
  environments: Env[];
  activeRuns: number;
  concurrency: { group: string; cancelInProgress: boolean } | null;
  initialValues?: InputValues;
  initialRef?: string;
  repoFullName: string;
  workflowPath: string;
}) {
  const router = useRouter();
  const fields = useMemo(
    () =>
      props.fields.map((f) =>
        f.type === "environment" && (!f.options || f.options.length === 0)
          ? { ...f, options: props.environments.map((e) => e.name) }
          : f,
      ),
    [props.fields, props.environments],
  );
  const [values, setValues] = useState<InputValues>(() => ({ ...defaultValues(fields), ...(props.initialValues ?? {}) }));
  const [ref, setRef] = useState(props.initialRef ?? props.defaultBranch);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const visible = fields.filter((f) => isVisible(f, values));
  const result = validateInputs(fields, values);
  const errors = { ...result.errors, ...serverErrors };
  const errorCount = Object.keys(result.errors).length;

  const envByName = new Map(props.environments.map((e) => [e.name.toLowerCase(), e]));
  const gates = [
    ...new Set(
      props.jobs
        .map((j) => resolveEnvironment(j.environment, values))
        .filter((e): e is string => !!e && !!envByName.get(e.toLowerCase())?.protected),
    ),
  ].map((e) => envByName.get(e.toLowerCase())!);

  function set(key: string, v: string | number | boolean) {
    setValues((prev) => ({ ...prev, [key]: v }));
    setServerErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function submit() {
    setSubmitted(true);
    setServerError(null);
    if (!result.ok) return;
    setBusy(true);
    const payload: InputValues = {};
    for (const f of fields) if (isVisible(f, values) && values[f.key] !== undefined) payload[f.key] = values[f.key];
    const res = await fetch("/api/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: props.workflowId, ref, inputs: payload, schemaVersion: props.versionId, idempotencyKey }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      router.push(`/runs/${body.id}`);
      return;
    }
    setServerError(body.message ?? "Couldn't start the run.");
    if (body.errors) setServerErrors(body.errors);
  }

  const show = (key: string) => submitted || touched[key];

  return (
    <section className="panel form-panel" aria-labelledby="form-title">
      <div className="panel-head">
        <h2 id="form-title">Run workflow</h2>
      </div>
      <div className="panel-body">
        <div className="field">
          <label className="label" htmlFor="ref">Branch or tag</label>
          <input className="input mono" id="ref" value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} />
          <span className="hint">
            {ref === props.defaultBranch
              ? "Inputs come from the workflow file on this branch."
              : "FlowDeck checks your inputs against the workflow file on this ref before starting."}
          </span>
        </div>

        {visible.map((f) => {
          const id = `in-${f.key}`;
          const err = show(f.key) ? errors[f.key] : undefined;
          const help = f.help ?? f.description;
          const common = {
            id,
            "aria-invalid": err ? true : undefined,
            "aria-describedby": err ? `${id}-err` : help ? `${id}-help` : undefined,
            onBlur: () => setTouched((t) => ({ ...t, [f.key]: true })),
          } as const;
          return (
            <div className="field" key={f.key}>
              {f.type === "boolean" ? (
                <div className="switch-row">
                  <span className="label" id={`${id}-label`}>{f.label}</span>
                  <button
                    type="button"
                    className="switch"
                    role="switch"
                    aria-checked={values[f.key] === true || values[f.key] === "true"}
                    aria-labelledby={`${id}-label`}
                    onClick={() => set(f.key, !(values[f.key] === true || values[f.key] === "true"))}
                  />
                </div>
              ) : (
                <label className="label" htmlFor={id}>
                  {f.label}
                  {f.required ? <span className="faint">Required</span> : f.min !== undefined && f.max !== undefined && f.type === "number" ? <span className="faint">{f.min} to {f.max}</span> : null}
                </label>
              )}

              {(f.type === "choice" || f.type === "environment") && f.options && f.options.length <= 4 && f.options.length > 0 ? (
                <div className="seg" role="radiogroup" aria-label={f.label}>
                  {f.options.map((o) => {
                    const env = f.type === "environment" || f.key.toLowerCase().includes("env") ? envByName.get(o.toLowerCase()) : undefined;
                    return (
                      <button type="button" role="radio" key={o} aria-checked={String(values[f.key]) === o} onClick={() => set(f.key, o)}>
                        {env?.protected && (
                          <span style={{ color: "var(--amber-mark)", display: "inline-flex" }}>
                            <Shield />
                          </span>
                        )}
                        {o}
                      </button>
                    );
                  })}
                </div>
              ) : f.type === "choice" || f.type === "environment" ? (
                <select className="select" {...common} value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                  {!f.required && <option value="">None</option>}
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : f.type === "number" ? (
                <input className="input num" type="number" inputMode="decimal" {...common} value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
              ) : f.type === "string" ? (
                <input
                  className={`input${f.pattern ? " mono" : ""}`}
                  type={f.sensitive ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  {...common}
                  value={String(values[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : null}

              {err ? (
                <span className="error-text" id={`${id}-err`}>{err}</span>
              ) : help ? (
                <span className="hint" id={`${id}-help`}>{help}</span>
              ) : null}
            </div>
          );
        })}

        {gates.map((g) => (
          <div className="field" key={g.name}>
            <div className="callout callout-wait">
              {g.name} needs approval ({g.approvers}) before its jobs start. You'll see the run wait until someone approves.
            </div>
          </div>
        ))}

        {props.activeRuns > 0 && props.concurrency && (
          <div className="field">
            <div className="callout callout-info">
              {props.activeRuns === 1 ? "Another run of this workflow is active." : `${props.activeRuns} runs of this workflow are active.`}{" "}
              {props.concurrency.cancelInProgress
                ? "This workflow cancels in-progress runs in the same concurrency group, so starting this one may cancel it."
                : "This workflow allows one run per concurrency group, so this one may wait until the other finishes."}
            </div>
          </div>
        )}

        <details className="preview">
          <summary>Request sent to GitHub</summary>
          <pre>
            {`POST /repos/${props.repoFullName}/actions/workflows/${props.workflowPath.split("/").pop()}/dispatches\n`}
            {JSON.stringify({ ref, return_run_details: true, inputs: result.serialized }, null, 2)}
          </pre>
        </details>

        {serverError && (
          <p className="callout callout-fail" role="alert" style={{ marginTop: 16 }}>
            {serverError}
          </p>
        )}
      </div>
      <div className="form-foot">
        <span className="small" style={{ color: errorCount && submitted ? "var(--red)" : "var(--ink-3)", fontWeight: 500 }}>
          {errorCount && submitted ? `${errorCount} ${errorCount === 1 ? "field needs" : "fields need"} attention` : "Recorded under your name"}
        </span>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Starting…" : "Run workflow"}
        </button>
      </div>
    </section>
  );
}

/**
 * Workflow input schema and validation.
 * Shared by the browser form and the server so both apply identical rules.
 */

export type InputType = "string" | "boolean" | "choice" | "number" | "environment";

export type InputField = {
  key: string;
  type: InputType;
  label: string;
  description?: string;
  required: boolean;
  default?: string | number | boolean;
  /** For "choice"; for "environment" filled from the repository's environments. */
  options?: string[];
  // Extensions from .github/flowdeck/<workflow file>
  pattern?: string;
  patternMessage?: string;
  min?: number;
  max?: number;
  help?: string;
  group?: string;
  /** Not shown in the form (e.g. flowdeck_requested_by, filled automatically). */
  hidden?: boolean;
  /** Masked in FlowDeck views and the audit log. */
  sensitive?: boolean;
  /** Show only when another input has a given value: { input: "canary", equals: "true" }. */
  visibleWhen?: { input: string; equals: string };
};

export const MAX_INPUTS = 25;
export const REQUESTED_BY_INPUT = "flowdeck_requested_by";

export type InputValues = Record<string, string | number | boolean | undefined>;

export type ValidationResult = {
  ok: boolean;
  errors: Record<string, string>;
  /** Values as GitHub expects them: every value is a string. */
  serialized: Record<string, string>;
};

export function defaultValues(fields: InputField[]): InputValues {
  const values: InputValues = {};
  for (const f of fields) {
    if (f.default !== undefined) values[f.key] = f.default;
    else if (f.type === "boolean") values[f.key] = false;
    else if ((f.type === "choice" || f.type === "environment") && f.options?.length && f.required)
      values[f.key] = f.options[0];
  }
  return values;
}

export function isVisible(field: InputField, values: InputValues): boolean {
  if (field.hidden) return false;
  if (!field.visibleWhen) return true;
  return String(values[field.visibleWhen.input] ?? "") === field.visibleWhen.equals;
}

function isBlank(v: unknown) {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export function validateInputs(fields: InputField[], values: InputValues): ValidationResult {
  const errors: Record<string, string> = {};
  const serialized: Record<string, string> = {};
  const known = new Set(fields.map((f) => f.key));

  for (const key of Object.keys(values)) {
    if (!known.has(key)) errors[key] = `"${key}" is not an input of this workflow.`;
  }

  for (const f of fields) {
    if (f.hidden) continue;
    const visible = isVisible(f, values);
    const raw = values[f.key];

    if (!visible) {
      // Hidden by a condition: send the default if there is one, otherwise nothing.
      if (f.default !== undefined) serialized[f.key] = String(f.default);
      continue;
    }

    if (isBlank(raw)) {
      if (f.required && f.type !== "boolean") {
        errors[f.key] = `${f.label} is required.`;
        continue;
      }
      if (f.type === "boolean") serialized[f.key] = "false";
      continue;
    }

    switch (f.type) {
      case "boolean": {
        const v = raw === true || raw === "true" ? "true" : raw === false || raw === "false" ? "false" : null;
        if (v === null) errors[f.key] = `${f.label} must be on or off.`;
        else serialized[f.key] = v;
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n)) {
          errors[f.key] = `${f.label} must be a number.`;
        } else if (f.min !== undefined && n < f.min) {
          errors[f.key] = `${f.label} must be ${f.min} or more.`;
        } else if (f.max !== undefined && n > f.max) {
          errors[f.key] = `${f.label} must be ${f.max} or less.`;
        } else {
          serialized[f.key] = String(n);
        }
        break;
      }
      case "choice":
      case "environment": {
        const v = String(raw);
        if (f.options && f.options.length > 0 && !f.options.includes(v)) {
          errors[f.key] = `Choose one of: ${f.options.join(", ")}.`;
        } else serialized[f.key] = v;
        break;
      }
      default: {
        const v = String(raw);
        if (f.pattern) {
          let re: RegExp | null = null;
          try {
            re = new RegExp(f.pattern);
          } catch {
            re = null;
          }
          if (re && !re.test(v)) {
            errors[f.key] = f.patternMessage ?? `${f.label} doesn't match the expected format.`;
            break;
          }
        }
        if (f.min !== undefined && v.length < f.min) {
          errors[f.key] = `${f.label} must be at least ${f.min} characters.`;
          break;
        }
        if (f.max !== undefined && v.length > f.max) {
          errors[f.key] = `${f.label} must be at most ${f.max} characters.`;
          break;
        }
        serialized[f.key] = v;
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, serialized };
}

export function maskInputs(fields: InputField[], inputs: Record<string, string>): Record<string, string> {
  const sensitive = new Set(fields.filter((f) => f.sensitive).map((f) => f.key));
  return Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, sensitive.has(k) ? "••••••" : v]));
}

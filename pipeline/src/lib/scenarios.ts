import crypto from "crypto";
import fs from "fs";
import YAML from "yaml";
import { Config } from "../config";
import { log } from "./log";

export interface RequestSpec {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Step {
  name: string;
  request: RequestSpec;
  /** Variables to keep from the response, e.g. { alice: "body.id" }. */
  save?: Record<string, string>;
  /** Vary the configured probe fields on this step. */
  probe?: boolean;
}

export interface ScenarioFile {
  fixtures: Step[];
  flows: Step[];
}

export type Phase = "fixture" | "flow" | "probe" | "verify" | "parity";

export interface Recording {
  id: string;
  phase: Phase;
  name: string;
  request: Required<RequestSpec>;
  response: { status: number; headers: Record<string, string>; body: unknown };
  traceId: string;
  ms: number;
}

export const loadScenarios = (file: string): ScenarioFile => {
  const s = YAML.parse(fs.readFileSync(file, "utf8"));
  return { fixtures: s.fixtures ?? [], flows: s.flows ?? [] };
};

export const get = (obj: any, dotted: string) =>
  dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Replaces {{var}} in strings, recursively. A string that is exactly {{var}} keeps the variable's type. */
export function fill(value: any, vars: Record<string, unknown>): any {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{(\w+)\}\}$/);
    if (whole) return vars[whole[1]];
    return value.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? `{{${k}}}`));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  }
  return value;
}

const KEEP_RESPONSE_HEADERS = ["content-type", "location", "idempotent-replay", "retry-after"];
let counter = 0;

/** Sends one step. Adds a W3C traceparent so every span the target emits can be tied back to this request. */
export async function send(
  baseUrl: string,
  step: Step,
  vars: Record<string, unknown>,
  phase: Phase,
  opts: { quiet?: boolean } = {},
): Promise<Recording> {
  const req = fill(step.request, vars) as RequestSpec;
  const traceId = crypto.randomBytes(16).toString("hex");
  const headers: Record<string, string> = {
    ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(req.headers ?? {}),
    traceparent: `00-${traceId}-${crypto.randomBytes(8).toString("hex")}-01`,
  };
  const started = Date.now();
  const res = await fetch(baseUrl + req.path, {
    method: req.method,
    headers,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  const respHeaders: Record<string, string> = {};
  for (const h of KEEP_RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v) respHeaders[h] = v;
  }
  delete headers.traceparent;
  const rec: Recording = {
    id: `${phase}-${String(++counter).padStart(3, "0")}`,
    phase,
    name: step.name,
    request: { method: req.method, path: req.path, headers, body: req.body ?? null },
    response: { status: res.status, headers: respHeaders, body },
    traceId,
    ms: Date.now() - started,
  };
  if (!opts.quiet) {
    const lvl = rec.response.status >= 500 ? "error" : "info";
    log[lvl](`${rec.id} ${step.name}: ${rec.request.method} ${rec.request.path} → ${rec.response.status} (${rec.ms}ms)`);
  }
  for (const [name, from] of Object.entries(step.save ?? {})) {
    vars[name] = get({ body, status: res.status, headers: respHeaders }, from);
  }
  return rec;
}

export async function runSteps(baseUrl: string, steps: Step[], vars: Record<string, unknown>, phase: Phase, opts: { quiet?: boolean } = {}) {
  const out: Recording[] = [];
  for (const step of steps) out.push(await send(baseUrl, step, vars, phase, opts));
  return out;
}

/** One probe per (step marked probe, configured field present in its body, value). */
export function buildProbes(cfg: Config, flows: Step[]): Step[] {
  const probes: Step[] = [];
  for (const step of flows.filter((s) => s.probe)) {
    const body = step.request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") continue;
    for (const field of cfg.probes.fields.filter((f) => f in body)) {
      for (const value of cfg.probes.values) {
        const headers = { ...(step.request.headers ?? {}) };
        for (const h of cfg.probes.dropHeaders) delete headers[h];
        probes.push({
          name: `${step.name} [${field}=${JSON.stringify(value)}]`,
          request: { ...step.request, headers, body: { ...body, [field]: value } },
        });
      }
    }
  }
  return probes;
}

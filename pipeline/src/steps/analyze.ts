import fs from "fs";
import path from "path";
import { Config, outPath, readJson, writeJson } from "../config";
import { askClaude, extractJson, hasApiKey } from "../lib/claude";
import { numbered, RequestTrace, sliceSource } from "../lib/evidence";
import { Analysis, FINDINGS_SCHEMA } from "../lib/findings";
import { loadScenarios, Recording } from "../lib/scenarios";
import { log } from "../lib/log";

const SYSTEM = `You are a reverse engineering analyst. You receive evidence about one area of a running system:
recorded HTTP requests and responses, the database statements each request ran (from traces),
the database schema, and the source files behind these routes with line numbers.

Describe how the system behaves, as findings a developer could rebuild it from.

Rules:
- Every finding cites evidence: recording ids (e.g. "probe-014"), traces as "trace:<recording id>",
  source lines as "src:<file>:<line>".
- tag: "Seen" if a recording directly shows it, "Inferred" if you concluded it from code or several
  observations, "Unknown" if the evidence cannot settle it.
- Add a probe to every finding that HTTP calls can test. The pipeline runs each probe on a fresh
  sandbox after the fixtures, so the fixture variables listed below are available as {{name}}.
  Findings without a passing probe are capped at "Inferred", so prefer testable claims.
- Cover edge cases the code reveals even if no recording hit them (thresholds, limits, states).
- Claims describe behavior in plain words: inputs, outputs, states, limits, errors. No code.
- Put open questions in "unknowns": behavior the code hints at that no endpoint or evidence settles.
- Reply with JSON only, in exactly this shape:
${FINDINGS_SCHEMA}`;

/** Groups the system by its first path segment; each group is analyzed by its own worker call. */
export function areasOf(recordings: Recording[], traces: RequestTrace[]) {
  const areas = new Map<string, { recordings: Recording[]; routes: Set<string> }>();
  for (const r of recordings) {
    const route = traces.find((t) => t.recordingId === r.id)?.route ?? r.request.path;
    const area = route.split("/").filter(Boolean)[0] ?? "root";
    const entry = areas.get(area) ?? { recordings: [], routes: new Set<string>() };
    entry.recordings.push(r);
    entry.routes.add(route);
    areas.set(area, entry);
  }
  return areas;
}

const compact = (v: unknown, max = 400) => {
  const s = JSON.stringify(v);
  return s && s.length > max ? s.slice(0, max) + "…" : s;
};

function evidenceFor(cfg: Config, area: string, recs: Recording[], routes: Set<string>, traces: RequestTrace[]) {
  const scen = loadScenarios(cfg.scenarios);
  const vars = scen.fixtures.flatMap((f) => Object.keys(f.save ?? {}).map((v) => `- {{${v}}}: saved by fixture "${f.name}"`));
  const rows = recs.map((r) => {
    const t = traces.find((x) => x.recordingId === r.id);
    const sql = (t?.sql ?? []).map((q) => `    - ${q.statement}${q.values ? `  values=${compact(q.values, 160)}` : ""}`);
    return [
      `#### ${r.id} (${r.phase}) ${r.name}`,
      `- request: ${r.request.method} ${r.request.path} headers=${compact(r.request.headers)} body=${compact(r.request.body)}`,
      `- response: ${r.response.status} headers=${compact(r.response.headers)} body=${compact(r.response.body)}`,
      `- route: ${t?.route ?? "?"}`,
      sql.length ? `- sql:\n${sql.join("\n")}` : "- sql: none",
    ].join("\n");
  });
  const schema = fs.existsSync(outPath(cfg, "capture", "schema.md")) ? fs.readFileSync(outPath(cfg, "capture", "schema.md"), "utf8") : "(none)";
  const files = cfg.target.source ? sliceSource(cfg.target.source.dir, cfg.target.source.extensions, [...routes]) : [];
  return [
    `# Area: /${area}`,
    `Routes observed: ${[...routes].join(", ")}`,
    `## Fixture variables (available in probes)\n${vars.join("\n")}`,
    `## Recorded requests\n${rows.join("\n\n")}`,
    `## Database schema\n${schema}`,
    `## Source files\n${files.map((f) => `### ${f.file}\n\`\`\`\n${numbered(f.content)}\n\`\`\``).join("\n\n")}`,
  ].join("\n\n");
}

/**
 * Step 6. One worker call per area. Auto mode calls the Claude API; manual mode writes the prompt
 * so a person (or a Claude session) can write findings.json for that area by hand.
 */
export async function analyze(cfg: Config, flags: Set<string>) {
  const recordings = readJson<Recording[]>(outPath(cfg, "capture", "recordings.json"));
  const traces = readJson<RequestTrace[]>(outPath(cfg, "capture", "traces.json"));
  const manual = flags.has("--manual") || !hasApiKey();
  log.input("Recorded requests", outPath(cfg, "capture", "recordings.json"));
  log.input("Traces (route + SQL per request)", outPath(cfg, "capture", "traces.json"));
  log.input("Database schema", outPath(cfg, "capture", "schema.md"));
  log.input("Source slice", outPath(cfg, "capture", "code-slice.md"));
  log.info(manual ? "mode: manual (no ANTHROPIC_API_KEY or --manual): prompts are written, findings come from findings.json files" : `mode: Claude API, model ${cfg.analysis.model}, one call per area`);
  const merged: Analysis = { findings: [], unknowns: [] };
  const status: Record<string, string> = {};

  for (const [area, { recordings: recs, routes }] of areasOf(recordings, traces)) {
    const evidence = evidenceFor(cfg, area, recs, routes, traces);
    log.info(`area /${area}: ${recs.length} requests, routes ${[...routes].join(", ")}; evidence bundle ${Math.round(evidence.length / 1000)}k chars`);
    const promptFile = outPath(cfg, "analysis", area, "prompt.md");
    fs.writeFileSync(promptFile, `<!-- system -->\n${SYSTEM}\n\n<!-- user -->\n${evidence}\n`);
    const findingsFile = outPath(cfg, "analysis", area, "findings.json");

    if (!manual && !flags.has("--keep")) {
      log.info(`area /${area}: calling Claude (${cfg.analysis.model})`);
      const t0 = Date.now();
      const reply = await askClaude({ model: cfg.analysis.model, maxTokens: cfg.analysis.maxTokens, system: SYSTEM, user: evidence });
      log.ok(`area /${area}: reply in ${Math.round((Date.now() - t0) / 1000)}s`);
      writeJson(findingsFile, extractJson(reply));
      status[area] = "analyzed via Claude API";
    } else if (fs.existsSync(findingsFile)) {
      status[area] = "using existing findings.json";
    } else {
      status[area] = `manual: write ${path.relative(cfg.root, findingsFile)} from ${path.relative(cfg.root, promptFile)}`;
      log.warn(`area /${area}: no findings yet; ${status[area]}`);
      log.output(`Prompt for /${area}`, promptFile);
      continue;
    }

    const result = readJson<Analysis>(findingsFile);
    log.ok(`area /${area}: ${result.findings.length} findings (${result.findings.filter((f) => f.probe).length} with probes), ${(result.unknowns ?? []).length} unknowns`);
    log.output(`Prompt for /${area} (what the analyst sees)`, promptFile);
    log.output(`Findings for /${area} (what the analyst wrote)`, findingsFile);
    merged.findings.push(...result.findings.map((f) => ({ ...f, area, id: `${area}-${f.id}` })));
    merged.unknowns.push(...(result.unknowns ?? []).map((u) => ({ ...u, area, id: `${area}-${u.id}` })));
  }

  writeJson(outPath(cfg, "analysis", "findings.json"), merged);
  log.output("All findings, merged", outPath(cfg, "analysis", "findings.json"));
  writeJson(outPath(cfg, "analysis", "meta.json"), { mode: manual ? "manual" : "api", model: cfg.analysis.model, areas: status });
  return { mode: manual ? "manual" : "api", areas: status, findings: merged.findings.length, unknowns: merged.unknowns.length };
}

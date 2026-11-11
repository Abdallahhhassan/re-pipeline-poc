import fs from "fs";
import path from "path";
import { Config, outPath, readJson, writeJson } from "../config";
import { askClaude, extractJson, hasApiKey } from "../lib/claude";
import { allSource, numbered, RequestTrace, sliceSource } from "../lib/evidence";
import { Analysis, FINDINGS_SCHEMA, UI_FINDINGS_SCHEMA } from "../lib/findings";
import type { Interaction, Screen } from "./crawl";
import { loadScenarios, Recording } from "../lib/scenarios";
import { log } from "../lib/log";
import { claudeTool } from "../lib/tools";

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

const UI_SYSTEM = `You are a reverse engineering analyst for a web app's screens. You receive what a browser
crawl saw: each screen's structure (accessibility tree), fields, buttons, links and the API calls it made
on load; then form tries where one value was changed at a time, with the message shown, all visible
text after the click, and each API call with its backend route, status and SQL. You also get the
front-end source with line numbers.

Describe what a person sees and can do, as findings a developer could rebuild the screens from.

Rules:
- Every finding cites evidence: screens as "ui:screen-01", form tries as "ui:ui-003", source lines as
  "src:<file>:<line>".
- route is "UI <screen>", e.g. "UI /#/send/:id".
- Add a uiProbe to every finding a browser can test. The pipeline opens goto (fixture variables are
  available as {{name}}), fills fields by their visible label, clicks the button named in click
  (leave click out to test what shows while typing), then checks expect: text that must be visible,
  an API call that must happen ("POST /transfers 201"), or one that must not ("POST /transfers").
  Each probe runs from fresh data. Findings without a passing probe are capped at "Inferred".
- If a screen calls an API route, you may add a finding for that route with an HTTP "probe" in the
  API shape: { "request": { "method", "path", "body" }, "expect": { "status", "body" } }.
- Separate rules the screen enforces itself (no API call) from rules it only reports from the API.
- Look for places where the screen and the API disagree, for example a value the screen computes
  itself that the API then computes differently. Those go in findings and in unknowns.
- Reply with JSON only, in exactly this shape:
${UI_FINDINGS_SCHEMA}`;

const clip = (s: string, max = 600) => (s.length > max ? s.slice(0, max) + "…" : s);

function uiEvidence(cfg: Config, screens: Screen[], tries: Interaction[]) {
  const scen = loadScenarios(cfg.scenarios);
  const vars = scen.fixtures.flatMap((f) => Object.keys(f.save ?? {}).map((v) => `- {{${v}}}: saved by fixture "${f.name}"`));
  const call = (c: Interaction["calls"][number]) =>
    `${c.method} ${c.path.replace(/[0-9a-f-]{36}/g, ":id")} → ${c.status} (route ${c.route ?? "?"})${c.sql.length ? `\n      sql: ${c.sql.filter((q) => !/^(BEGIN|COMMIT)$/.test(q)).join(" | ")}` : ""}`;
  const screenRows = screens.map((s) =>
    [
      `#### ${s.id} ${s.template}: "${s.heading}"`,
      `- fields: ${s.fields.map((f) => `${f.label} (${f.kind}${f.options ? `: ${f.options.join(", ")}` : ""})`).join("; ") || "none"}`,
      `- buttons: ${s.buttons.join(", ") || "none"}`,
      `- API calls on load:\n${s.loadCalls.map((c) => `    - ${call(c)}`).join("\n") || "    - none"}`,
      `- structure:\n\`\`\`\n${clip(s.structure, 1500)}\n\`\`\``,
    ].join("\n"),
  );
  const tryRows = tries.map((t) =>
    [
      `#### ${t.id} ${t.name}`,
      `- typed: ${JSON.stringify(t.fill)}, then clicked "${t.click}" on ${t.goto}`,
      `- message: ${t.messages.join(" ") || "(none)"}`,
      `- API calls after the click:\n${t.calls.map((c) => `    - ${call(c)}`).join("\n") || "    - none"}`,
      `- visible text after the click:\n${t.screenText.split("\n").map((l) => `    > ${l}`).join("\n")}`,
    ].join("\n"),
  );
  const files = cfg.ui?.source ? allSource(cfg.ui.source.dir, cfg.ui.source.extensions) : [];
  return [
    `# Area: the UI`,
    `Screens: ${screens.map((s) => s.template).join(", ")}`,
    `## Fixture variables (available in probes)\n${vars.join("\n")}`,
    `## Screens\n${screenRows.join("\n\n")}`,
    `## Form tries (one value changed at a time, fresh data each time)\n${tryRows.join("\n\n")}`,
    `## Front-end source\n${files.map((f) => `### ${f.file}\n\`\`\`\n${numbered(f.content)}\n\`\`\``).join("\n\n")}`,
  ].join("\n\n");
}

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
  log.tool({ name: "Evidence builder", purpose: "packs each area's requests, SQL, schema and source lines into one prompt", where: "pipeline/src/steps/analyze.ts (evidenceFor)" });
  if (manual) log.tool({ name: "Manual analysis", purpose: "with no API key, a person or a Claude chat writes findings.json from each prompt", where: "out/analysis/<area>/prompt.md" });
  else log.tool(claudeTool(cfg, cfg.analysis.model));
  log.info(manual ? "mode: manual (no ANTHROPIC_API_KEY or --manual): prompts are written, findings come from findings.json files" : `mode: Claude API, model ${cfg.analysis.model}, one call per area`);
  const merged: Analysis = { findings: [], unknowns: [] };
  const status: Record<string, string> = {};

  const jobs: { area: string; system: string; evidence: string; about: string }[] = [];
  for (const [area, { recordings: recs, routes }] of areasOf(recordings, traces)) {
    jobs.push({ area, system: SYSTEM, evidence: evidenceFor(cfg, area, recs, routes, traces), about: `${recs.length} requests, routes ${[...routes].join(", ")}` });
  }
  // The UI is its own area: screens and form tries from the browser crawl, plus the front-end source.
  if (cfg.ui && fs.existsSync(outPath(cfg, "ui", "screens.json"))) {
    const screens = readJson<Screen[]>(outPath(cfg, "ui", "screens.json"));
    const tries = readJson<Interaction[]>(outPath(cfg, "ui", "interactions.json"));
    log.input("UI crawl: screens", outPath(cfg, "ui", "screens.json"));
    log.input("UI crawl: form tries", outPath(cfg, "ui", "interactions.json"));
    jobs.push({ area: "ui", system: UI_SYSTEM, evidence: uiEvidence(cfg, screens, tries), about: `${screens.length} screens, ${tries.length} form tries` });
  }

  for (const { area, system, evidence, about } of jobs) {
    log.info(`area /${area}: ${about}; evidence bundle ${Math.round(evidence.length / 1000)}k chars`);
    const promptFile = outPath(cfg, "analysis", area, "prompt.md");
    fs.writeFileSync(promptFile, `<!-- system -->\n${system}\n\n<!-- user -->\n${evidence}\n`);
    const findingsFile = outPath(cfg, "analysis", area, "findings.json");

    if (!manual && !flags.has("--keep")) {
      log.info(`area /${area}: calling Claude (${cfg.analysis.model})`);
      const t0 = Date.now();
      const reply = await askClaude({ model: cfg.analysis.model, maxTokens: cfg.analysis.maxTokens, system, user: evidence });
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
    log.ok(`area /${area}: ${result.findings.length} findings (${result.findings.filter((f) => f.probe || f.uiProbe).length} with probes), ${(result.unknowns ?? []).length} unknowns`);
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

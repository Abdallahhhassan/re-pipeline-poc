import fs from "fs";
import { Config, outPath, readJson, writeJson } from "../config";
import { RequestTrace } from "../lib/evidence";
import { Finding, Unknown } from "../lib/findings";
import { Recording } from "../lib/scenarios";
import type { Screen } from "./crawl";
import { log } from "../lib/log";

type Verified = Finding & { probeResult: "pass" | "fail" | "none" };

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function fieldTypes(samples: unknown[]) {
  const out: Record<string, Set<string>> = {};
  for (const s of samples) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    for (const [k, v] of Object.entries(s)) (out[k] ??= new Set()).add(typeOf(v));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].join(" | ")]));
}

const tablesIn = (sql: string, verbs: RegExp) => [...sql.matchAll(verbs)].map((m) => m[1].toLowerCase());

/** The API contract as observed: per route, request fields, statuses, response fields, tables touched. */
export function buildContract(recordings: Recording[], traces: RequestTrace[]) {
  const byRoute = new Map<string, { recs: Recording[]; sql: string[] }>();
  for (const r of recordings) {
    const t = traces.find((x) => x.recordingId === r.id);
    const key = `${r.request.method} ${t?.route ?? r.request.path}`;
    const e = byRoute.get(key) ?? { recs: [], sql: [] };
    e.recs.push(r);
    e.sql.push(...(t?.sql ?? []).map((q) => q.statement));
    byRoute.set(key, e);
  }
  return [...byRoute.entries()].map(([route, { recs, sql }]) => {
    const statuses = [...new Set(recs.map((r) => r.response.status))].sort();
    return {
      route,
      requestFields: fieldTypes(recs.map((r) => r.request.body)),
      requestHeaders: [...new Set(recs.flatMap((r) => Object.keys(r.request.headers)))].filter((h) => h !== "content-type"),
      responses: Object.fromEntries(
        statuses.map((s) => {
          const ex = recs.filter((r) => r.response.status === s);
          return [s, { fields: fieldTypes(ex.map((r) => r.response.body)), headers: Object.keys(ex[0].response.headers), example: ex[0].response.body }];
        }),
      ),
      tablesRead: [...new Set(sql.flatMap((q) => tablesIn(q, /\bFROM\s+([a-z_]+)/gi)))],
      tablesWritten: [...new Set(sql.flatMap((q) => tablesIn(q, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi)))],
    };
  });
}

/** Step 8. Merges verified findings, the observed contract and open questions into the spec the builder works from. */
export async function spec(cfg: Config) {
  const results = readJson<Verified[]>(outPath(cfg, "verify", "results.json"));
  const unknowns = readJson<Unknown[]>(outPath(cfg, "verify", "unknowns.json"));
  const recordings = readJson<Recording[]>(outPath(cfg, "capture", "recordings.json"));
  const traces = readJson<RequestTrace[]>(outPath(cfg, "capture", "traces.json"));
  log.tool({ name: "Contract builder", purpose: "derives fields, statuses and tables touched per route from the recorded traffic and traces", where: "pipeline/src/steps/spec.ts (buildContract)" });
  log.tool({ name: "Spec writer", purpose: "turns verified rules and open questions into the markdown spec", where: "pipeline/src/steps/spec.ts" });
  log.input("Verified findings", outPath(cfg, "verify", "results.json"));
  log.input("Unknowns", outPath(cfg, "verify", "unknowns.json"));
  log.input("Traffic and traces (for the contract)", outPath(cfg, "capture", "recordings.json"));
  const contract = buildContract(recordings, traces);
  writeJson(outPath(cfg, "spec", "contract.json"), contract);
  log.ok(`contract: ${contract.length} routes with fields, statuses and tables touched`);

  const routes = [...new Set([...contract.map((c) => c.route), ...results.map((r) => r.route)])].sort();
  const sections = routes.map((route) => {
    const c = contract.find((x) => x.route === route);
    const fs_ = results.filter((r) => r.route === route);
    const line = (f: Verified) => `- **${f.claim}** _(${f.tag}; ${f.id})_`;
    return [
      `## ${route}`,
      c ? `Request fields: ${Object.entries(c.requestFields).map(([k, t]) => `\`${k}\`: ${t}`).join(", ") || "none"}` : "",
      c?.requestHeaders.length ? `Request headers used: ${c.requestHeaders.map((h) => `\`${h}\``).join(", ")}` : "",
      c ? `Statuses seen: ${Object.keys(c.responses).join(", ")}. Tables written: ${c.tablesWritten.join(", ") || "none"}.` : "",
      "",
      "**Verified behavior (Seen)**",
      ...fs_.filter((f) => f.tag === "Seen").map(line),
      "",
      "**Not yet proven (Inferred)**",
      ...(fs_.filter((f) => f.tag === "Inferred" && f.probeResult !== "fail").map(line).concat(fs_.some((f) => f.tag === "Inferred" && f.probeResult !== "fail") ? [] : ["- none"])),
      ...(fs_.some((f) => f.probeResult === "fail")
        ? ["", "**Refuted by its test (do not build)**", ...fs_.filter((f) => f.probeResult === "fail").map((f) => `- ~~${f.claim}~~ _(${f.id})_`)]
        : []),
    ]
      .filter((l) => l !== undefined)
      .join("\n");
  });

  // With a UI crawl, the builder also gets each screen's structure: labels, buttons and texts, not its code.
  const screens: Screen[] = cfg.ui && fs.existsSync(outPath(cfg, "ui", "screens.json")) ? readJson<Screen[]>(outPath(cfg, "ui", "screens.json")) : [];
  if (screens.length) log.input("Screens from the UI crawl", outPath(cfg, "ui", "screens.json"));
  const screenSection = screens.length
    ? [
        "## Screens (from the browser crawl)",
        "Rebuild these screens at the same addresses, with the same labels, button names and messages. The look is yours.",
        "",
        ...screens.map((s) =>
          [
            `### ${s.template}: ${s.heading}`,
            `Loads: ${s.loadCalls.map((c) => `${c.method} ${c.route ?? c.path}`).join(", ") || "nothing"}`,
            "```",
            s.structure.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id"),
            "```",
          ].join("\n"),
        ),
        "",
      ].join("\n")
    : "";

  const md = [
    `# Behavior spec: ${cfg.target.name}`,
    "",
    "Generated from captured traffic, traces, schema and source, then verified against the sandbox.",
    "Seen = a probe passed. Inferred = concluded but not proven. Build from Seen; ask about the rest.",
    "",
    sections.join("\n\n"),
    "",
    screenSection,
    "## Unknowns (people decide before the build)",
    ...unknowns.map((u) => `- **${u.question}** ${u.why} _(${u.id})_`),
    "",
  ].join("\n");
  fs.writeFileSync(outPath(cfg, "spec", "spec.md"), md);
  log.ok(`spec: ${results.filter((r) => r.tag === "Seen").length} verified rules, ${results.filter((r) => r.tag !== "Seen").length} not yet proven, ${unknowns.length} open questions`);
  fs.writeFileSync(outPath(cfg, "spec", "unknowns.md"), ["# Unknowns", "", ...unknowns.map((u) => `- [ ] ${u.question} (${u.id})`), ""].join("\n"));
  log.output("Behavior spec (what the builder gets)", outPath(cfg, "spec", "spec.md"));
  log.output("Observed API contract", outPath(cfg, "spec", "contract.json"));
  log.output("Unknowns checklist", outPath(cfg, "spec", "unknowns.md"));
  return { routes: routes.length, seen: results.filter((r) => r.tag === "Seen").length, unknowns: unknowns.length };
}

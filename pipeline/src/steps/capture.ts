import fs from "fs";
import path from "path";
import { Config, outPath, writeJson } from "../config";
import { log } from "../lib/log";
import { startService, sh } from "../lib/proc";
import { buildProbes, loadScenarios, Recording, runSteps, send } from "../lib/scenarios";
import { dumpSchema, linkTraces, numbered, readSpans, sliceSource } from "../lib/evidence";
import { processTool, requestTool, resetTool } from "../lib/tools";

/**
 * Steps 1-5 of the pipeline, no AI involved:
 * trace + record the scenarios, probe one field at a time from a fresh state,
 * then snapshot the schema and the source files behind the observed routes.
 */
export async function capture(cfg: Config) {
  const traceFile = outPath(cfg, "capture", "spans.jsonl");
  fs.rmSync(traceFile, { force: true });
  const scen = loadScenarios(cfg.scenarios);
  const probes = buildProbes(cfg, scen.flows);
  log.input("Config: target", path.join(cfg.root, "re.config.yaml"));
  log.input("Scenarios", cfg.scenarios);
  log.input("Probe plan", undefined, `fields: ${cfg.probes.fields.join(", ")}\nvalues: ${JSON.stringify(cfg.probes.values)}\n=> ${probes.length} probes, each from a fresh state`);
  const recordings: Recording[] = [];
  log.tool(resetTool(cfg.target));
  log.tool(processTool);
  if (cfg.target.tracing === "node-auto") {
    log.tool({
      name: "OpenTelemetry Node SDK + auto-instrumentations",
      purpose: "injected with NODE_OPTIONS, traces every request through http, express and pg, and writes each span to a file",
      where: "pipeline/src/otel/register.cjs",
      link: "https://opentelemetry.io/docs/languages/js/",
    });
  }
  log.tool(requestTool);

  sh(cfg, cfg.target.reset.command);
  const svc = await startService(cfg, cfg.target, {
    label: "target",
    traceFile: cfg.target.tracing === "node-auto" ? traceFile : undefined,
  });
  try {
    const vars: Record<string, unknown> = {};
    log.info(`run ${scen.fixtures.length} fixtures (test data setup)`);
    recordings.push(...(await runSteps(cfg.target.baseUrl, scen.fixtures, vars, "fixture")));
    log.info(`run ${scen.flows.length} journey steps`);
    recordings.push(...(await runSteps(cfg.target.baseUrl, scen.flows, vars, "flow")));

    // Controlled probing: change one input, from a fresh state each time.
    log.info(`probe: ${probes.length} variations, each after a data reset and the ${scen.fixtures.length} fixtures`);
    for (const probe of probes) {
      sh(cfg, cfg.target.reset.command, { quiet: true });
      const pv: Record<string, unknown> = {};
      await runSteps(cfg.target.baseUrl, scen.fixtures, pv, "fixture", { quiet: true });
      recordings.push(await send(cfg.target.baseUrl, probe, pv, "probe"));
    }
  } finally {
    await svc.stop();
  }

  log.tool({ name: "Trace linker", purpose: "groups spans by trace id and pulls out each request's route and SQL", where: "pipeline/src/lib/evidence.ts (linkTraces)" });
  const spans = readSpans(traceFile);
  const traces = linkTraces(recordings, spans);
  log.ok(`linked ${spans.length} spans to ${traces.filter((t) => t.spans > 0).length} of ${recordings.length} requests through their traceparent ids`);
  writeJson(outPath(cfg, "capture", "recordings.json"), recordings);
  writeJson(outPath(cfg, "capture", "traces.json"), traces);
  log.output("Recorded requests and responses", outPath(cfg, "capture", "recordings.json"));
  log.output("Route and SQL per request (from traces)", outPath(cfg, "capture", "traces.json"));

  const routes = [...new Set(traces.map((t) => t.route).filter((r): r is string => !!r))];
  log.info(`routes seen: ${routes.join(", ")}`);
  let schema = "";
  if (cfg.target.database) {
    log.tool({ name: "node-postgres (pg)", purpose: "reads tables, columns and constraints from the live database", where: "pipeline/src/lib/evidence.ts (dumpSchema)", link: "https://node-postgres.com" });
    schema = await dumpSchema(cfg.target.database.url);
    fs.writeFileSync(outPath(cfg, "capture", "schema.md"), schema + "\n");
    log.ok(`schema read from the live database: ${(schema.match(/^### /gm) ?? []).length} tables`);
    log.output("Database schema", outPath(cfg, "capture", "schema.md"));
  }
  let files: { file: string; content: string }[] = [];
  if (cfg.target.source) {
    log.tool({ name: "Source slicer", purpose: "finds the files that mention each route and follows their imports", where: "pipeline/src/lib/evidence.ts (sliceSource)" });
    files = sliceSource(cfg.target.source.dir, cfg.target.source.extensions, routes);
    fs.writeFileSync(
      outPath(cfg, "capture", "code-slice.md"),
      files.map((f) => `### ${f.file}\n\`\`\`\n${numbered(f.content)}\n\`\`\``).join("\n\n") + "\n",
    );
    log.ok(`source slice: ${files.length} files behind those routes (${files.map((f) => path.basename(f.file)).join(", ")})`);
    log.output("Source files behind the routes, with line numbers", outPath(cfg, "capture", "code-slice.md"));
  }

  const summary = {
    recordings: recordings.length,
    byPhase: countBy(recordings.map((r) => r.phase)),
    statuses: countBy(recordings.map((r) => String(r.response.status))),
    tracedRequests: traces.filter((t) => t.spans > 0).length,
    spans: spans.length,
    tables: (schema.match(/^### /gm) ?? []).length,
    routes,
    sqlStatements: traces.reduce((n, t) => n + t.sql.length, 0),
    schemaCaptured: !!schema,
    sourceFiles: files.map((f) => f.file),
  };
  writeJson(outPath(cfg, "capture", "summary.json"), summary);
  return summary;
}

const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

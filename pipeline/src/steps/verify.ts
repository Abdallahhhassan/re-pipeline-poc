import { Config, outPath, readJson, ServiceConfig, writeJson } from "../config";
import { RequestTrace } from "../lib/evidence";
import { Analysis, Finding, Probe, Tag } from "../lib/findings";
import { partialMatch } from "../lib/match";
import { sh, startService } from "../lib/proc";
import { loadScenarios, Recording, runSteps, send } from "../lib/scenarios";
import { log } from "../lib/log";

export interface ProbeOutcome {
  passed: boolean;
  actual: { status: number; body: unknown; headers: Record<string, string> };
}

/** Runs one probe from a fresh state: reset, fixtures, optional setup, then the probe request. */
export async function runProbe(cfg: Config, svc: ServiceConfig, probe: Probe): Promise<ProbeOutcome> {
  sh(cfg, svc.reset.command, { quiet: true });
  const vars: Record<string, unknown> = {};
  const scen = loadScenarios(cfg.scenarios);
  await runSteps(svc.baseUrl, scen.fixtures, vars, "verify", { quiet: true });
  if (probe.setup?.length) await runSteps(svc.baseUrl, probe.setup, vars, "verify", { quiet: true });
  const rec = await send(svc.baseUrl, { name: "probe", request: probe.request }, vars, "verify", { quiet: true });
  const headersOk = Object.entries(probe.expect.headers ?? {}).every(
    ([k, v]) => rec.response.headers[k.toLowerCase()] === v,
  );
  const passed =
    rec.response.status === probe.expect.status &&
    (probe.expect.body === undefined || partialMatch(probe.expect.body, rec.response.body)) &&
    headersOk;
  return { passed, actual: { status: rec.response.status, body: rec.response.body, headers: rec.response.headers } };
}

/**
 * Step 7. Every claim with a probe is tested against the sandbox.
 * Pass -> Seen. Fail -> refuted, sent back to analysis. No probe -> capped at Inferred.
 * Routes the traces saw but no finding explains become unknowns.
 */
export async function verify(cfg: Config) {
  const analysis = readJson<Analysis>(outPath(cfg, "analysis", "findings.json"));
  const recordings = readJson<Recording[]>(outPath(cfg, "capture", "recordings.json"));
  const traces = readJson<RequestTrace[]>(outPath(cfg, "capture", "traces.json"));

  log.input("Findings to test", outPath(cfg, "analysis", "findings.json"));
  log.input("Traffic (for the coverage check)", outPath(cfg, "capture", "recordings.json"));
  log.info(`each probe runs on a fresh sandbox: reset data, run the fixtures, run any setup steps, then the probe request`);
  const svc = await startService(cfg, cfg.target, { label: "target-verify" });
  const results: (Finding & { claimedTag: Tag; probeResult: "pass" | "fail" | "none"; actual?: unknown })[] = [];
  try {
    for (const f of analysis.findings) {
      if (!f.probe) {
        log.warn(`${f.id}: no probe, capped at Inferred: ${f.claim}`);
        results.push({ ...f, claimedTag: f.tag, tag: f.tag === "Unknown" ? "Unknown" : "Inferred", probeResult: "none" });
        continue;
      }
      const out = await runProbe(cfg, cfg.target, f.probe);
      const exp = f.probe.expect.status;
      const line = `${f.id}: ${f.probe.request.method} ${f.probe.request.path} → ${out.actual.status} (expected ${exp}${f.probe.expect.body ? " + body fields" : ""})`;
      if (out.passed) log.ok(`${line} → Seen`);
      else log.error(`${line} → refuted, back to analysis`);
      results.push({
        ...f,
        claimedTag: f.tag,
        tag: out.passed ? "Seen" : f.tag === "Unknown" ? "Unknown" : "Inferred",
        probeResult: out.passed ? "pass" : "fail",
        ...(out.passed ? {} : { actual: out.actual }),
      });
    }
  } finally {
    await svc.stop();
  }

  // Coverage: every observed "METHOD route" should be explained by at least one finding.
  const observed = new Set(
    recordings.map((r) => `${r.request.method} ${traces.find((t) => t.recordingId === r.id)?.route ?? r.request.path}`),
  );
  const explained = new Set(analysis.findings.map((f) => f.route));
  const uncovered = [...observed].filter((r) => !explained.has(r));

  const unknowns = [
    ...analysis.unknowns,
    ...uncovered.map((route, i) => ({
      id: `coverage-${i + 1}`,
      area: route.split("/")[1] ?? "root",
      question: `What does ${route} do? It was exercised but no finding explains it.`,
      why: "Coverage gate: traced route with no finding.",
    })),
  ];

  if (uncovered.length) log.warn(`coverage: ${uncovered.length} traced routes have no finding: ${uncovered.join(", ")}`);
  else log.ok(`coverage: every traced route (${observed.size}) is explained by at least one finding`);
  const passed = results.filter((r) => r.probeResult === "pass");
  writeJson(outPath(cfg, "verify", "results.json"), results);
  writeJson(outPath(cfg, "verify", "failed-claims.json"), results.filter((r) => r.probeResult === "fail"));
  writeJson(outPath(cfg, "verify", "unknowns.json"), unknowns);
  // Passing probes become a regression suite that the rebuild must also pass.
  writeJson(outPath(cfg, "verify", "suite.json"), passed.map((r) => ({ id: r.id, claim: r.claim, probe: r.probe })));
  log.output("Every finding with its verdict", outPath(cfg, "verify", "results.json"));
  log.output("Refuted claims", outPath(cfg, "verify", "failed-claims.json"));
  log.output("Unknowns (analysis + coverage gaps)", outPath(cfg, "verify", "unknowns.json"));
  log.output("Acceptance suite for the rebuild (passing probes)", outPath(cfg, "verify", "suite.json"));

  return {
    findings: results.length,
    seen: passed.length,
    failedProbes: results.filter((r) => r.probeResult === "fail").map((r) => r.id),
    inferredOnly: results.filter((r) => r.probeResult === "none").length,
    unknowns: unknowns.length,
    uncoveredRoutes: uncovered,
  };
}

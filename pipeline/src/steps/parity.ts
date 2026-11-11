import fs from "fs";
import { Config, outPath, readJson, ServiceConfig, writeJson } from "../config";
import { Probe } from "../lib/findings";
import { diff, mask } from "../lib/match";
import { sh, startService } from "../lib/proc";
import { buildProbes, loadScenarios, Recording, runSteps, send, Step } from "../lib/scenarios";
import { runProbe } from "./verify";
import { log } from "../lib/log";
import { processTool, requestTool, resetTool } from "../lib/tools";

interface Comparison {
  case: string;
  request: string;
  same: boolean;
  differences: string[];
}

const view = (cfg: Config, r: { status: number; body: unknown; headers: Record<string, string> }) => ({
  status: r.status,
  body: mask(r.body, cfg.parity.ignoreFields),
  "idempotent-replay": r.headers["idempotent-replay"],
});

/** Runs the same steps from the same fresh state on one service. */
async function play(cfg: Config, svc: ServiceConfig, steps: { fixtures: Step[]; run: Step[] }): Promise<Recording[]> {
  sh(cfg, svc.reset.command, { quiet: true });
  const vars: Record<string, unknown> = {};
  await runSteps(svc.baseUrl, steps.fixtures, vars, "parity", { quiet: true });
  return runSteps(svc.baseUrl, steps.run, vars, "parity", { quiet: true });
}

/**
 * Step 10. Replays the scenarios, the capture probes and the verified finding probes against
 * the original and the rebuild from identical fresh states, and diffs what clients would see.
 */
export async function parity(cfg: Config) {
  if (!cfg.rebuilt) throw new Error("No `rebuilt` service in the config");
  const scen = loadScenarios(cfg.scenarios);
  const suite = readJson<{ id: string; claim: string; probe: Probe }[]>(outPath(cfg, "verify", "suite.json"));

  log.tool(processTool);
  log.tool(resetTool(cfg.target));
  log.tool(requestTool);
  log.tool({ name: "Response differ", purpose: "masks ids and timestamps, then lists every field that differs between the two services", where: "pipeline/src/lib/match.ts (mask, diff)" });
  log.input("Scenarios (journeys + probe plan)", cfg.scenarios);
  log.input("Acceptance suite (verified probes)", outPath(cfg, "verify", "suite.json"));
  log.input("Masked fields and accepted differences", undefined, `ignore: ${cfg.parity.ignoreFields.join(", ")}\naccepted: ${cfg.parity.accepted.map((a) => a.case).join("; ") || "none"}`);
  const original = await startService(cfg, cfg.target, { label: "parity-original" });
  const rebuilt = await startService(cfg, cfg.rebuilt, { label: "parity-rebuilt" });
  const results: Comparison[] = [];
  try {
    const compare = (name: string, a: Recording[], b: Recording[]) => {
      a.forEach((ra, i) => {
        const d = diff(view(cfg, ra.response), view(cfg, b[i].response));
        const msg = `${name}: ${ra.name}: ${ra.request.method} ${ra.request.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")} → original ${ra.response.status}, rebuild ${b[i].response.status}`;
        if (d.length) log.warn(`${msg}: ${d.length} differences`); else log.ok(msg);
        results.push({ case: `${name}: ${ra.name}`, request: `${ra.request.method} ${ra.request.path}`, same: !d.length, differences: d });
      });
    };

    // 1. The user journeys, end to end.
    const journey = { fixtures: [], run: [...scen.fixtures, ...scen.flows] };
    compare("journey", await play(cfg, cfg.target, journey), await play(cfg, cfg.rebuilt, journey));

    // 2. Each capture probe, from a fresh state.
    for (const probe of buildProbes(cfg, scen.flows)) {
      const steps = { fixtures: scen.fixtures, run: [probe] };
      compare("probe", await play(cfg, cfg.target, steps), await play(cfg, cfg.rebuilt, steps));
    }

    // 3. Each verified claim: the rebuild must pass the same probe, and answer like the original.
    for (const item of suite) {
      const a = await runProbe(cfg, cfg.target, item.probe);
      const b = await runProbe(cfg, cfg.rebuilt, item.probe);
      const d = diff(view(cfg, a.actual), view(cfg, b.actual));
      if (!b.passed) d.unshift(`claim not met by rebuild: expected ${JSON.stringify(item.probe.expect)}`);
      const msg = `claim ${item.id}: original ${a.actual.status}, rebuild ${b.actual.status}`;
      if (d.length) log.warn(`${msg}: ${d.length} differences`); else log.ok(msg);
      results.push({ case: `claim ${item.id}: ${item.claim}`, request: `${item.probe.request.method} ${item.probe.request.path}`, same: !d.length, differences: d });
    }
  } finally {
    await original.stop();
    await rebuilt.stop();
  }

  // Differences people already reviewed and accepted (quirks we chose not to copy) are listed, not counted.
  const acceptedFor = (c: Comparison) => cfg.parity.accepted.find((a) => a.case === c.case);
  const accepted = results.filter((r) => !r.same && acceptedFor(r));
  const failed = results.filter((r) => !r.same && !acceptedFor(r));
  const rate = results.length ? failed.length / results.length : 0;
  writeJson(outPath(cfg, "parity", "report.json"), { total: results.length, different: failed.length, accepted: accepted.length, diffRate: rate, results });
  const md = [
    `# Parity report`,
    "",
    `${results.length - failed.length - accepted.length} of ${results.length} cases match, ${accepted.length} accepted, ${failed.length} open (diff rate ${(rate * 100).toFixed(1)}%).`,
    "",
    ...(accepted.length
      ? ["## Accepted differences (reviewed quirks)", ...accepted.map((a) => `- ${a.case}: ${acceptedFor(a)!.reason}`), ""]
      : []),
    "## Open differences",
    ...(failed.length
      ? ["| Case | Request | Differences (original vs rebuild) |", "| --- | --- | --- |",
         ...failed.map((f) => `| ${f.case} | ${f.request} | ${f.differences.join("<br>").replace(/\|/g, "\\|")} |`)]
      : ["No differences."]),
    "",
  ].join("\n");
  fs.writeFileSync(outPath(cfg, "parity", "report.md"), md);
  log.info(`${results.length} cases: ${results.length - failed.length - accepted.length} match, ${accepted.length} accepted, ${failed.length} open`);
  fs.writeFileSync(
    outPath(cfg, "parity", "diffs-for-builder.md"),
    failed.map((f) => `- ${f.case}\n  - request: ${f.request}\n  - ${f.differences.join("\n  - ")}`).join("\n") + "\n",
  );
  log.output("Parity report", outPath(cfg, "parity", "report.md"));
  log.output("Differences, formatted for the builder", outPath(cfg, "parity", "diffs-for-builder.md"));
  return { total: results.length, different: failed.length, accepted: accepted.length, diffRate: `${(rate * 100).toFixed(1)}%`, firstDiffs: failed.slice(0, 5) };
}

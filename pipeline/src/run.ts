import fs from "fs";
import path from "path";
import { Config, loadConfig, outPath, readJson } from "./config";
import { capture } from "./steps/capture";
import { analyze } from "./steps/analyze";
import { verify } from "./steps/verify";
import { spec } from "./steps/spec";
import { rebuild } from "./steps/rebuild";
import { parity } from "./steps/parity";
import { site } from "./steps/site";
import { beginStep, endStep, log } from "./lib/log";

type StepFn = (cfg: Config, flags: Set<string>) => Promise<unknown>;

/** How each step is presented in logs and in the UI. `n` maps to the whiteboard's step numbers. */
export const STEP_META: Record<string, { order: number; n: string; title: string; does: string }> = {
  capture: { order: 1, n: "1-5", title: "Capture", does: "Starts the target in the sandbox with tracing injected, runs the scenarios, probes one field at a time from a fresh state, then reads the schema and the source behind the routes. No AI." },
  analyze: { order: 2, n: "6", title: "Analyze", does: "Splits the system into areas and gives each area's evidence to an analyst (Claude via API, or manual). Gets back findings tagged Seen, Inferred or Unknown, each with evidence and a probe." },
  verify: { order: 3, n: "7", title: "Verify", does: "Runs every finding's probe on a fresh sandbox. Pass makes it Seen, fail refutes it. Routes no finding explains become unknowns." },
  spec: { order: 4, n: "8", title: "Spec", does: "Merges verified findings, the observed API contract and open questions into the spec the builder works from." },
  rebuild: { order: 5, n: "9", title: "Rebuild", does: "Clean room: a builder gets only the spec, contract and acceptance probes, and writes a new service in its own design." },
  parity: { order: 6, n: "10", title: "Parity", does: "Replays journeys, probes and verified claims on the original and the rebuild from identical fresh states and diffs what clients see." },
  report: { order: 7, n: "R", title: "Report", does: "Writes one page for people: what is proven, what was refuted, what needs a decision, how close the rebuild is." },
  site: { order: 8, n: "UI", title: "Results page", does: "Renders this page from the run's outputs." },
};

const STEPS: Record<string, StepFn> = {
  capture: (cfg) => capture(cfg),
  analyze: (cfg, flags) => analyze(cfg, flags),
  verify: (cfg) => verify(cfg),
  spec: (cfg) => spec(cfg),
  rebuild: (cfg, flags) => rebuild(cfg, flags),
  parity: (cfg) => parity(cfg),
  report: async (cfg) => report(cfg),
  site: (cfg) => site(cfg),
};

/** The nightly run. Rebuild only runs when asked (--rebuild), because it rewrites code. */
function allSteps(cfg: Config, flags: Set<string>) {
  const hasRebuild = cfg.rebuilt && fs.existsSync(path.resolve(cfg.root, cfg.rebuild.dir, "dist"));
  return [
    "capture",
    "analyze",
    "verify",
    "spec",
    ...(flags.has("--rebuild") ? ["rebuild"] : []),
    ...(hasRebuild || flags.has("--rebuild") ? ["parity"] : []),
    "report",
    "site",
  ];
}

/** One page for people: what is proven, what failed, what needs a decision, how close the rebuild is. */
function report(cfg: Config) {
  const get = (...p: string[]) => (fs.existsSync(outPath(cfg, ...p)) ? readJson(outPath(cfg, ...p)) : null);
  const results = get("verify", "results.json") ?? [];
  const unknowns = get("verify", "unknowns.json") ?? [];
  const par = get("parity", "report.json");
  const seen = results.filter((r: any) => r.tag === "Seen").length;
  const failed = results.filter((r: any) => r.probeResult === "fail");
  log.input("Verdicts", outPath(cfg, "verify", "results.json"));
  log.input("Unknowns", outPath(cfg, "verify", "unknowns.json"));
  if (par) log.input("Parity results", outPath(cfg, "parity", "report.json"));
  const md = [
    `# Reverse engineering run: ${cfg.target.name}`,
    "",
    `Run at ${new Date().toISOString()}.`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Findings | ${results.length} |`,
    `| Proven by a probe (Seen) | ${seen} |`,
    `| Claims refuted by their probe | ${failed.length} |`,
    `| Open unknowns for people | ${unknowns.length} |`,
    `| Rebuild parity | ${par ? `${par.total - par.different - (par.accepted ?? 0)}/${par.total} match, ${par.accepted ?? 0} accepted, ${par.different} open` : "not run"} |`,
    "",
    "## Refuted claims (go back to analysis)",
    ...(failed.length ? failed.map((f: any) => `- ${f.id}: ${f.claim}`) : ["- none"]),
    "",
    "## Unknowns (people decide)",
    ...unknowns.map((u: any) => `- ${u.question} (${u.id})`),
    "",
    "Details: out/spec/spec.md, out/verify/results.json, out/parity/report.md",
    "",
  ].join("\n");
  log.ok(`${seen} of ${results.length} findings proven, ${failed.length} refuted, ${unknowns.length} open questions`);
  if (par) log.ok(`parity: ${par.total - par.different - (par.accepted ?? 0)} of ${par.total} cases match, ${par.accepted ?? 0} accepted, ${par.different} open`);
  fs.writeFileSync(outPath(cfg, "report.md"), md);
  log.output("Run report", outPath(cfg, "report.md"));
  return { findings: results.length, seen, refuted: failed.length, unknowns: unknowns.length, parity: par ? { total: par.total, open: par.different, accepted: par.accepted ?? 0 } : "not run" };
}

async function main() {
  const [step = "all", ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const cfg = loadConfig(rest.find((a) => !a.startsWith("--")) ?? "re.config.yaml");
  const order = step === "all" ? allSteps(cfg, flags) : [step];
  // A full run starts a fresh run log so the page never mixes two runs.
  if (step === "all") fs.rmSync(path.join(cfg.outDir, "runlog"), { recursive: true, force: true });
  for (const name of order) {
    const fn = STEPS[name];
    if (!fn) throw new Error(`Unknown step "${name}". Steps: ${Object.keys(STEPS).join(", ")}, all`);
    const meta = STEP_META[name];
    console.log(`\n== ${meta.n} ${meta.title} ==`);
    beginStep({ step: name, ...meta }, cfg.root);
    try {
      const result = await fn(cfg, flags);
      endStep(cfg.outDir, meta.order, { summary: result });
      if (result !== undefined) console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      endStep(cfg.outDir, meta.order, { error: err });
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

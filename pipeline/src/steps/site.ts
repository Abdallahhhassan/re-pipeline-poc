import fs from "fs";
import path from "path";
import { Config, outPath } from "../config";
import { log } from "../lib/log";

const TEMPLATE = path.resolve(__dirname, "../../ui/template.html");

const STEPS: [string, string, string[] | null][] = [
  ["0", "Sandbox", null],
  ["1", "Trace", ["capture", "traces.json"]],
  ["2", "Record", ["capture", "recordings.json"]],
  ["3", "Crawl", null],
  ["4", "Data", ["capture", "schema.md"]],
  ["5", "Index code", ["capture", "code-slice.md"]],
  ["6", "Analyze", ["analysis", "findings.json"]],
  ["7", "Verify", ["verify", "results.json"]],
  ["8", "Spec", ["spec", "spec.md"]],
  ["9", "Rebuild", null],
  ["10", "Parity", ["parity", "report.json"]],
];

/** Renders the latest run into one self-contained page: site/index.html (GitHub Pages serves it as is). */
export async function site(cfg: Config) {
  const read = (...p: string[]) => {
    const f = outPath(cfg, ...p);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  };
  const has = (...p: string[]) => fs.existsSync(outPath(cfg, ...p));
  const rebuiltExists = fs.existsSync(path.resolve(cfg.root, cfg.rebuild.dir, "src"));
  const meta = read("analysis", "meta.json");
  const runlogDir = outPath(cfg, "runlog", "x");
  const runlog = fs
    .readdirSync(path.dirname(runlogDir))
    .filter((f) => f.endsWith(".json") && !f.endsWith("-site.json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(path.dirname(runlogDir), f), "utf8")));
  log.input("Run log of each step", path.dirname(runlogDir));
  log.info(`${runlog.length} step records found: ${runlog.map((r: any) => r.step).join(", ")}`);

  const data = {
    target: cfg.target.name,
    generatedAt: new Date().toISOString(),
    analysisMode: meta?.mode === "api" ? `Claude API (${cfg.analysis.model})` : "manual (findings written from the generated prompts)",
    steps: STEPS.map(([n, name, file]) => {
      if (n === "0") return { n, name, ran: true, note: "local databases, reset per run" };
      if (n === "3") return { n, name, ran: false, note: "scenarios written by hand" };
      if (n === "9") return { n, name, ran: rebuiltExists, note: rebuiltExists ? "rebuilt/ from the spec" : "not built" };
      return { n, name, ran: !!file && has(...file), note: !!file && has(...file) ? "done" : "not run" };
    }),
    runlog,
    rebuildNote: rebuiltExists ? "rebuilt/ is in the repo, written earlier from the spec. Run make rebuild to regenerate it, then parity checks it again." : "No rebuild yet. Run make rebuild.",
    results: read("verify", "results.json") ?? [],
    unknowns: read("verify", "unknowns.json") ?? [],
    parity: read("parity", "report.json"),
    acceptedDifferences: cfg.parity.accepted,
    recordings: read("capture", "recordings.json") ?? [],
    traces: read("capture", "traces.json") ?? [],
    contract: read("spec", "contract.json") ?? [],
    links: cfg.site.links,
  };

  // Keep the embedded JSON from closing the <script> tag early.
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = fs.readFileSync(TEMPLATE, "utf8").replace("/*__DATA__*/", () => payload);
  const outFile = path.resolve(cfg.root, "site", "index.html");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);
  log.output("Results page", outFile);
  return { page: path.relative(cfg.root, outFile), kb: Math.round(html.length / 1024) };
}

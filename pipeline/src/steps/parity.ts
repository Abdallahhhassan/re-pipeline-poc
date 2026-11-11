import fs from "fs";
import path from "path";
import { Config, outPath, readJson, ServiceConfig, writeJson } from "../config";
import { launchBrowser, tracedPage, UiProbe } from "../lib/browser";
import { Probe } from "../lib/findings";
import { diff, mask } from "../lib/match";
import { sh, startService } from "../lib/proc";
import { buildProbes, loadScenarios, Recording, runSteps, send, Step } from "../lib/scenarios";
import { describeUi, runProbe, runUiProbe, UiOutcome } from "./verify";
import { Interaction, READ_SCREEN } from "./crawl";
import { log } from "../lib/log";
import { processTool, requestTool, resetTool } from "../lib/tools";

interface Comparison {
  case: string;
  request: string;
  same: boolean;
  differences: string[];
  kind?: "api" | "ui";
  /** Screenshots of the same moment on both services, relative to out/. */
  shots?: { original: string; rebuild: string };
}

/** What a person would notice between two runs of the same UI action: the message and the API calls. */
function uiDiff(a: UiOutcome, b: UiOutcome) {
  const d: string[] = [];
  const ma = a.actual.messages.join(" "), mb = b.actual.messages.join(" ");
  if (ma !== mb) d.push(`message: ${JSON.stringify(ma)} vs ${JSON.stringify(mb)}`);
  // Sorted: screens load data in parallel, so the order of calls is not part of the behavior.
  const ca = [...a.actual.requests].sort().join(", "), cb = [...b.actual.requests].sort().join(", ");
  if (ca !== cb) d.push(`API calls: ${ca || "none"} vs ${cb || "none"}`);
  return d;
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
  const suite = readJson<{ id: string; claim: string; probe?: Probe; uiProbe?: UiProbe }[]>(outPath(cfg, "verify", "suite.json"));
  const tries: Interaction[] = cfg.ui && fs.existsSync(outPath(cfg, "ui", "interactions.json")) ? readJson(outPath(cfg, "ui", "interactions.json")) : [];
  const withUi = !!cfg.ui && (tries.length > 0 || suite.some((s) => s.uiProbe));

  log.tool(processTool);
  log.tool(resetTool(cfg.target));
  log.tool(requestTool);
  log.tool({ name: "Response differ", purpose: "masks ids and timestamps, then lists every field that differs between the two services", where: "pipeline/src/lib/match.ts (mask, diff)" });
  if (withUi) log.tool({ name: "Playwright (Chrome)", purpose: "repeats every UI action on both services, compares what the person sees and which API calls happen, and takes screenshots side by side", where: "pipeline/src/steps/parity.ts + pipeline/src/lib/browser.ts", link: "https://playwright.dev" });
  log.input("Scenarios (journeys + probe plan)", cfg.scenarios);
  if (tries.length) log.input("UI form tries from the crawl", outPath(cfg, "ui", "interactions.json"));
  log.input("Acceptance suite (verified probes)", outPath(cfg, "verify", "suite.json"));
  log.input("Masked fields and accepted differences", undefined, `ignore: ${cfg.parity.ignoreFields.join(", ")}\naccepted: ${cfg.parity.accepted.map((a) => a.case).join("; ") || "none"}`);
  const original = await startService(cfg, cfg.target, { label: "parity-original" });
  const rebuilt = await startService(cfg, cfg.rebuilt, { label: "parity-rebuilt" });
  const results: Comparison[] = [];
  const shotDir = path.dirname(outPath(cfg, "parity", "ui", "x"));
  fs.rmSync(shotDir, { recursive: true, force: true });
  fs.mkdirSync(shotDir, { recursive: true });
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  let shotN = 0;
  /** Runs one UI action on both services from identical fresh data, with a screenshot of each. */
  const both = async (probe: UiProbe) => {
    const n = String(++shotN).padStart(3, "0");
    const shots = { original: path.join(shotDir, `${n}-original.jpg`), rebuild: path.join(shotDir, `${n}-rebuild.jpg`) };
    const a = await runUiProbe(cfg, cfg.target, browser!, probe, shots.original);
    const b = await runUiProbe(cfg, cfg.rebuilt!, browser!, probe, shots.rebuild);
    return { a, b, shots: { original: path.relative(cfg.outDir, shots.original), rebuild: path.relative(cfg.outDir, shots.rebuild) } };
  };
  try {
    if (withUi) browser = await launchBrowser();
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
      if (item.uiProbe) {
        if (!browser) continue;
        const { a, b, shots } = await both(item.uiProbe);
        const d = uiDiff(a, b);
        if (!b.passed) d.unshift(`claim not met by rebuild: ${b.problems.join("; ")}`);
        const msg = `claim ${item.id} in Chrome: ${describeUi(item.uiProbe)}`;
        if (d.length) log.warn(`${msg}: ${d.length} differences`); else log.ok(`${msg}: same`);
        results.push({ case: `claim ${item.id}: ${item.claim}`, request: describeUi(item.uiProbe), same: !d.length, differences: d, kind: "ui", shots });
        continue;
      }
      if (!item.probe) continue;
      const a = await runProbe(cfg, cfg.target, item.probe);
      const b = await runProbe(cfg, cfg.rebuilt, item.probe);
      const d = diff(view(cfg, a.actual), view(cfg, b.actual));
      if (!b.passed) d.unshift(`claim not met by rebuild: expected ${JSON.stringify(item.probe.expect)}`);
      const msg = `claim ${item.id}: original ${a.actual.status}, rebuild ${b.actual.status}`;
      if (d.length) log.warn(`${msg}: ${d.length} differences`); else log.ok(msg);
      results.push({ case: `claim ${item.id}: ${item.claim}`, request: `${item.probe.request.method} ${item.probe.request.path}`, same: !d.length, differences: d });
    }

    if (browser) {
      // 4. Every form try from the crawl, on both: same message, same API calls?
      for (const t of tries) {
        const probe: UiProbe = { goto: t.goto, fill: t.fill, click: t.click, expect: {} };
        const { a, b, shots } = await both(probe);
        const d = uiDiff(a, b);
        const msg = `ui: ${t.name}: original "${a.actual.messages.join(" ")}", rebuild "${b.actual.messages.join(" ")}"`;
        if (d.length) log.warn(`${msg}: ${d.length} differences`); else log.ok(msg);
        results.push({ case: `ui: ${t.name}`, request: describeUi(probe), same: !d.length, differences: d, kind: "ui", shots });
      }

      // 5. The screens themselves: same heading, field labels and buttons? The look is allowed to differ.
      for (const screen of cfg.ui?.compareScreens ?? []) {
        const { a, b, shots } = await both({ goto: screen, expect: {} });
        const read = async (svc: ServiceConfig) => {
          sh(cfg, svc.reset.command, { quiet: true });
          const vars: Record<string, unknown> = {};
          await runSteps(svc.baseUrl, scen.fixtures, vars, "parity", { quiet: true });
          const { page, context } = await tracedPage(browser!);
          await page.goto(svc.baseUrl + (screen.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k]))));
          await page.waitForLoadState("networkidle");
          const info = (await page.evaluate(READ_SCREEN)) as { heading: string; fields: { label: string }[]; buttons: string[] };
          await context.close();
          return { heading: info.heading, fields: info.fields.map((f) => f.label).join(", "), buttons: info.buttons.join(", ") };
        };
        const ia = await read(cfg.target), ib = await read(cfg.rebuilt);
        const d = (["heading", "fields", "buttons"] as const).filter((k) => ia[k] !== ib[k]).map((k) => `${k}: ${JSON.stringify(ia[k])} vs ${JSON.stringify(ib[k])}`);
        d.push(...uiDiff(a, b).filter((x) => x.startsWith("API calls")));
        const msg = `screen ${screen}: heading, fields and buttons`;
        if (d.length) log.warn(`${msg}: ${d.length} differences`); else log.ok(`${msg} match; screenshots saved`);
        results.push({ case: `screen: ${screen.replace(/\{\{\w+\}\}/g, ":id")}`, request: `open ${screen}`, same: !d.length, differences: d, kind: "ui", shots });
      }
    }
  } finally {
    await browser?.close();
    await original.stop();
    await rebuilt.stop();
  }

  // Differences people already reviewed and accepted (quirks we chose not to copy) are listed, not counted.
  // An accepted entry names a case exactly, or by its prefix before ":" (e.g. "claim ui-F13").
  const acceptedFor = (c: Comparison) => cfg.parity.accepted.find((a) => a.case === c.case || c.case.startsWith(a.case + ":"));
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
  if (withUi) log.output("Screenshots, original and rebuild", shotDir);
  return { total: results.length, different: failed.length, accepted: accepted.length, diffRate: `${(rate * 100).toFixed(1)}%`, firstDiffs: failed.slice(0, 5) };
}

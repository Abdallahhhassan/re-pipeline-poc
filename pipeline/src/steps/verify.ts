import fs from "fs";
import path from "path";
import { Browser } from "playwright";
import { Config, outPath, readJson, ServiceConfig, writeJson } from "../config";
import { checkUi, launchBrowser, runUiAction, snap, tracedPage, UiProbe } from "../lib/browser";
import { RequestTrace } from "../lib/evidence";
import { Analysis, Finding, Probe, Tag } from "../lib/findings";
import { partialMatch } from "../lib/match";
import { sh, startService } from "../lib/proc";
import { fill, loadScenarios, Recording, runSteps, send } from "../lib/scenarios";
import type { Interaction, Screen } from "./crawl";
import { log } from "../lib/log";
import { processTool, requestTool, resetTool } from "../lib/tools";

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

export interface UiOutcome {
  passed: boolean;
  problems: string[];
  actual: { url: string; messages: string[]; requests: string[]; screenText: string };
}

/** Same idea for a UI rule: fresh data, open the screen in Chrome, fill, click, check what shows and which calls happened. */
export async function runUiProbe(cfg: Config, svc: ServiceConfig, browser: Browser, probe: UiProbe, screenshot?: string): Promise<UiOutcome> {
  sh(cfg, svc.reset.command, { quiet: true });
  const vars: Record<string, unknown> = {};
  await runSteps(svc.baseUrl, loadScenarios(cfg.scenarios).fixtures, vars, "verify", { quiet: true });
  if (probe.setup?.length) await runSteps(svc.baseUrl, probe.setup, vars, "verify", { quiet: true });
  const { page, context, calls, consoleErrors } = await tracedPage(browser);
  try {
    const res = await runUiAction(page, calls, consoleErrors, svc.baseUrl, probe, vars);
    const problems = await checkUi(page, res, fill(probe.expect, vars));
    if (res.consoleErrors.length) problems.push(...res.consoleErrors.map((e) => `console error: ${e}`));
    if (screenshot) {
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      await snap(page, screenshot);
    }
    return {
      passed: problems.length === 0,
      problems,
      actual: {
        url: res.url,
        messages: res.messages,
        requests: res.requests.map((c) => `${c.method} ${c.path.split("?")[0].replace(/[0-9a-f-]{36}/g, ":id")} ${c.status}`),
        screenText: res.screenText,
      },
    };
  } finally {
    await context.close();
  }
}

/** A one-line description of a UI probe for logs: "open /#/send/:id, Amount=0, click Send money". */
export const describeUi = (p: UiProbe) =>
  [`open ${p.goto.replace(/\{\{\w+\}\}/g, ":id")}`, ...Object.entries(p.fill ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`), ...(p.click ? [`click ${p.click}`] : [])].join(", ");

/**
 * Step 7. Every claim with a probe is tested against the sandbox.
 * Pass -> Seen. Fail -> refuted, sent back to analysis. No probe -> capped at Inferred.
 * Routes the traces saw but no finding explains become unknowns.
 */
export async function verify(cfg: Config) {
  const analysis = readJson<Analysis>(outPath(cfg, "analysis", "findings.json"));
  const recordings = readJson<Recording[]>(outPath(cfg, "capture", "recordings.json"));
  const traces = readJson<RequestTrace[]>(outPath(cfg, "capture", "traces.json"));

  log.tool({ name: "Probe runner", purpose: "runs each rule's test from a fresh state and compares status, body and headers", where: "pipeline/src/steps/verify.ts (runProbe) + pipeline/src/lib/match.ts" });
  log.tool(resetTool(cfg.target));
  log.tool(requestTool);
  log.tool(processTool);
  const needsBrowser = analysis.findings.some((f) => f.uiProbe);
  if (needsBrowser) log.tool({ name: "Playwright (Chrome)", purpose: "runs each UI rule in a real browser: opens the screen, fills fields by label, clicks, checks the visible text and the API calls", where: "pipeline/src/steps/verify.ts (runUiProbe) + pipeline/src/lib/browser.ts", link: "https://playwright.dev" });
  log.input("Findings to test", outPath(cfg, "analysis", "findings.json"));
  log.input("Traffic (for the coverage check)", outPath(cfg, "capture", "recordings.json"));
  log.info(`each probe runs on a fresh sandbox: reset data, run the fixtures, run any setup steps, then the probe request`);
  const svc = await startService(cfg, cfg.target, { label: "target-verify" });
  const results: (Finding & { claimedTag: Tag; probeResult: "pass" | "fail" | "none"; actual?: unknown; problems?: string[]; screenshot?: string })[] = [];
  let browser: Browser | null = null;
  try {
    if (needsBrowser) browser = await launchBrowser();
    for (const f of analysis.findings) {
      if (f.uiProbe && browser) {
        const shot = outPath(cfg, "verify", "ui", `${f.id}.jpg`);
        const out = await runUiProbe(cfg, cfg.target, browser, f.uiProbe, shot);
        const line = `${f.id}: in Chrome: ${describeUi(f.uiProbe)} → ${out.actual.messages.join(" ") || "(no message)"}`;
        if (out.passed) log.ok(`${line} → Seen`);
        else log.error(`${line} → refuted (${out.problems.join("; ")}), back to analysis`);
        results.push({
          ...f,
          claimedTag: f.tag,
          tag: out.passed ? "Seen" : f.tag === "Unknown" ? "Unknown" : "Inferred",
          probeResult: out.passed ? "pass" : "fail",
          screenshot: path.relative(cfg.outDir, shot),
          ...(out.passed ? {} : { actual: out.actual, problems: out.problems }),
        });
        continue;
      }
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
    await browser?.close();
    await svc.stop();
  }

  // Coverage: every observed "METHOD route" should be explained by at least one finding.
  // With a UI crawl, every screen and every API route the screens called count too.
  const observed = new Set(
    recordings.map((r) => `${r.request.method} ${traces.find((t) => t.recordingId === r.id)?.route ?? r.request.path}`),
  );
  if (cfg.ui && fs.existsSync(outPath(cfg, "ui", "screens.json"))) {
    const screens = readJson<Screen[]>(outPath(cfg, "ui", "screens.json"));
    const tries = readJson<Interaction[]>(outPath(cfg, "ui", "interactions.json"));
    for (const s of screens) observed.add(`UI ${s.template}`);
    for (const c of [...screens.flatMap((s) => s.loadCalls), ...tries.flatMap((t) => t.calls)]) if (c.route) observed.add(`${c.method} ${c.route}`);
    log.input("UI crawl (for the coverage check)", outPath(cfg, "ui", "screens.json"));
  }
  const explained = new Set(analysis.findings.map((f) => f.route));
  const uncovered = [...observed].filter((r) => !explained.has(r));

  const unknowns = [
    ...analysis.unknowns,
    ...uncovered.map((route, i) => ({
      id: `coverage-${i + 1}`,
      area: route.split("/")[1] ?? "root",
      question: route.startsWith("UI ") ? `What is the screen ${route.slice(3)} for? The crawl opened it but no finding explains it.` : `What does ${route} do? It was exercised but no finding explains it.`,
      why: "Coverage gate: traced route with no finding.",
    })),
  ];

  if (uncovered.length) log.warn(`coverage: ${uncovered.length} traced routes have no finding: ${uncovered.join(", ")}`);
  else log.ok(`coverage: every traced route and screen (${observed.size}) is explained by at least one finding`);
  const passed = results.filter((r) => r.probeResult === "pass");
  writeJson(outPath(cfg, "verify", "results.json"), results);
  writeJson(outPath(cfg, "verify", "failed-claims.json"), results.filter((r) => r.probeResult === "fail"));
  writeJson(outPath(cfg, "verify", "unknowns.json"), unknowns);
  // Passing probes become a regression suite that the rebuild must also pass.
  writeJson(outPath(cfg, "verify", "suite.json"), passed.map((r) => ({ id: r.id, claim: r.claim, ...(r.uiProbe ? { uiProbe: r.uiProbe } : { probe: r.probe }) })));
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

import fs from "fs";
import path from "path";
import { Config, outPath, writeJson } from "../config";
import { ApiCall, launchBrowser, runUiAction, screenTemplate, snap, tracedPage } from "../lib/browser";
import { readSpans } from "../lib/evidence";
import { log } from "../lib/log";
import { sh, startService } from "../lib/proc";
import { loadScenarios, runSteps } from "../lib/scenarios";
import { processTool, resetTool } from "../lib/tools";

export interface Field {
  label: string;
  kind: string;
  options?: string[];
}

export interface TracedCall extends ApiCall {
  route: string | null;
  sql: string[];
}

export interface Screen {
  id: string;
  template: string;
  url: string;
  title: string;
  heading: string;
  structure: string;
  fields: Field[];
  buttons: string[];
  links: string[];
  loadCalls: TracedCall[];
  consoleErrors: string[];
  screenshot: string;
}

export interface Interaction {
  id: string;
  form: string;
  name: string;
  goto: string;
  fill: Record<string, string>;
  click: string;
  messages: string[];
  /** Everything visible in the main area after the click, e.g. a fee preview next to the result. */
  screenText: string;
  calls: TracedCall[];
  screenshot?: string;
}

/** Runs in the page. A plain string so the TypeScript runner does not inject helpers the page lacks. */
export const READ_SCREEN = `(() => {
  const labelOf = (el) => (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : "") || el.getAttribute("aria-label") || el.getAttribute("name") || "";
  return {
    heading: (document.querySelector("h1")?.textContent || "").trim(),
    fields: [...document.querySelectorAll("input, select, textarea")].map((el) => ({
      label: labelOf(el),
      kind: el.tagName === "INPUT" ? "input " + el.type : el.tagName.toLowerCase(),
      ...(el.tagName === "SELECT" ? { options: [...el.options].map((o) => o.text) } : {}),
    })),
    buttons: [...document.querySelectorAll("button")].map((b) => b.innerText.trim()),
    links: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || ""),
  };
})()`;

/**
 * Step 3: walks the UI in a real browser (Playwright), one screen at a time, then fills each
 * configured form with one value changed per try, from fresh data. Every API call the page makes
 * carries a traceparent, so clicks are tied to backend routes and SQL.
 */
export async function crawl(cfg: Config) {
  if (!cfg.ui) {
    log.warn("no ui section in re.config.yaml, skipping");
    return { skipped: true };
  }
  const ui = cfg.ui;
  const base = cfg.target.baseUrl;
  const shotDir = outPath(cfg, "ui", "screens", "x");
  fs.rmSync(path.dirname(shotDir), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(shotDir), { recursive: true });
  const traceFile = outPath(cfg, "ui", "spans.jsonl");
  fs.rmSync(traceFile, { force: true });

  log.tool({ name: "Playwright", purpose: "drives Chrome: opens each screen, reads its structure, fills forms by their labels, clicks buttons, takes screenshots", where: "pipeline/src/lib/browser.ts", link: "https://playwright.dev" });
  log.tool({ name: "Playwright request routing", purpose: "adds a traceparent header to the page's API calls, as the OpenTelemetry browser SDK would, so each click links to backend spans", where: "pipeline/src/lib/browser.ts (tracedPage)" });
  log.tool({ name: "OpenTelemetry Node SDK + auto-instrumentations", purpose: "traces the backend while the browser clicks around", where: "pipeline/src/otel/register.cjs", link: "https://opentelemetry.io/docs/languages/js/" });
  log.tool(resetTool(cfg.target));
  log.tool(processTool);
  log.input("UI settings (start page, forms to try)", path.join(cfg.root, "re.config.yaml"));
  log.input("Scenarios (fixtures create the test wallets)", cfg.scenarios);

  const scen = loadScenarios(cfg.scenarios);
  const fresh = async () => {
    sh(cfg, cfg.target.reset.command, { quiet: true });
    const vars: Record<string, unknown> = {};
    await runSteps(base, scen.fixtures, vars, "fixture", { quiet: true });
    return vars;
  };

  sh(cfg, cfg.target.reset.command);
  const svc = await startService(cfg, cfg.target, { label: "target-ui", traceFile: cfg.target.tracing === "node-auto" ? traceFile : undefined });
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  const screens: (Omit<Screen, "loadCalls"> & { loadCalls: ApiCall[] })[] = [];
  const interactions: (Omit<Interaction, "calls"> & { calls: ApiCall[] })[] = [];
  try {
    browser = await launchBrowser();
    log.ok(`browser started: Chrome ${browser.version()}`);
    // 1. Explore: follow in-app links breadth first, one screen per URL shape.
    await fresh();
    log.info(`explore from ${ui.startPath}, up to ${ui.maxScreens} screens, one per URL shape`);
    const { page, calls, consoleErrors } = await tracedPage(browser);
    const queue = [ui.startPath];
    const seen = new Set<string>();
    while (queue.length && screens.length < ui.maxScreens) {
      const target = queue.shift()!;
      const before = calls.length;
      const errorsBefore = consoleErrors.length;
      // A full load per screen, so hash routes render from scratch and networkidle covers their fetches.
      await page.goto("about:blank");
      await page.goto(base + target);
      await page.waitForLoadState("networkidle");
      const template = screenTemplate(page.url());
      if (seen.has(template)) continue;
      seen.add(template);
      const id = `screen-${String(screens.length + 1).padStart(2, "0")}`;
      const info = (await page.evaluate(READ_SCREEN)) as { heading: string; fields: Field[]; buttons: string[]; links: string[] };
      const shot = path.join(path.dirname(shotDir), `${id}.jpg`);
      await snap(page, shot);
      const structure = await page.locator("main").ariaSnapshot().catch(() => page.locator("body").ariaSnapshot());
      screens.push({
        id, template, url: page.url(), title: await page.title(), structure, ...info,
        loadCalls: calls.slice(before), consoleErrors: consoleErrors.slice(errorsBefore),
        screenshot: path.relative(cfg.outDir, shot),
      });
      log.ok(`${id} ${template}: "${info.heading}", ${info.fields.length} fields, ${info.buttons.length} buttons, ${calls.length - before} API calls on load`);
      const basePath = new URL(page.url()).pathname;
      for (const href of info.links) {
        if (href.startsWith("#")) queue.push(basePath + href);
        else if (href.startsWith("/")) queue.push(href);
      }
    }
    await page.context().close();

    // 2. Forms: base values, then one field varied at a time, each from fresh data.
    for (const form of ui.forms) {
      const tries = [{ name: form.name, values: form.fill ?? {} }];
      for (const v of form.vary?.values ?? []) {
        tries.push({ name: `${form.name} [${form.vary!.field}=${JSON.stringify(v)}]`, values: { ...form.fill, [form.vary!.field]: v } });
      }
      log.info(`form "${form.name}": ${tries.length} tries, each after a data reset and the fixtures`);
      for (const t of tries) {
        const vars = await fresh();
        const tp = await tracedPage(browser);
        const res = await runUiAction(tp.page, tp.calls, tp.consoleErrors, base, { goto: form.goto, fill: t.values, click: form.submit }, vars);
        const id = `ui-${String(interactions.length + 1).padStart(3, "0")}`;
        let screenshot: string | undefined;
        if (t.name === form.name) {
          const shot = path.join(path.dirname(shotDir), `${id}.jpg`);
          await snap(tp.page, shot);
          screenshot = path.relative(cfg.outDir, shot);
        }
        interactions.push({ id, form: form.name, name: t.name, goto: form.goto, fill: t.values, click: form.submit, messages: res.messages, screenText: res.screenText, calls: res.requests, screenshot });
        const call = res.requests.map((c) => `${c.method} ${c.path.split("?")[0].replace(/[0-9a-f-]{36}/g, ":id")} → ${c.status}`).join(", ") || "no API call";
        log.info(`${id} ${t.name}: ${call}; shows "${res.messages.join(" ") || "(nothing)"}"`);
        await tp.context.close();
      }
    }
  } finally {
    await browser?.close();
    await svc.stop();
  }

  // 3. Tie each API call to its backend route and SQL through the trace id.
  const spans = readSpans(traceFile);
  const byTrace = new Map<string, typeof spans>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  const enrich = (c: ApiCall): TracedCall => {
    const own = (byTrace.get(c.traceId) ?? []).sort((a, b) => a.startMs - b.startMs);
    const server = own.find((s) => s.kind === 1 && s.attributes["http.route"]);
    const sql = own
      .map((s) => (s.attributes["db.query.text"] ?? s.attributes["db.statement"]) as string | undefined)
      .filter((q): q is string => !!q)
      .map((q) => q.replace(/\s+/g, " ").trim());
    return { ...c, route: server?.attributes["http.route"] ?? null, sql };
  };
  const outScreens: Screen[] = screens.map((s) => ({ ...s, loadCalls: s.loadCalls.map(enrich) }));
  const outInteractions: Interaction[] = interactions.map((i) => ({ ...i, calls: i.calls.map(enrich) }));
  const linked = [...outScreens.flatMap((s) => s.loadCalls), ...outInteractions.flatMap((i) => i.calls)];
  log.ok(`linked ${linked.filter((c) => c.route).length} of ${linked.length} API calls from the browser to backend routes and SQL (${spans.length} spans)`);

  writeJson(outPath(cfg, "ui", "screens.json"), outScreens);
  writeJson(outPath(cfg, "ui", "interactions.json"), outInteractions);
  log.output("Screens: structure, fields, buttons, links, API calls on load", outPath(cfg, "ui", "screens.json"));
  log.output("Form tries: what was typed, what the page said, API calls and their SQL", outPath(cfg, "ui", "interactions.json"));
  log.output("Screenshots", path.dirname(shotDir));

  return {
    screens: outScreens.length,
    templates: outScreens.map((s) => s.template),
    interactions: outInteractions.length,
    apiCalls: linked.length,
    linkedCalls: linked.filter((c) => c.route).length,
    spans: spans.length,
  };
}

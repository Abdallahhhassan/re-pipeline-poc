import crypto from "crypto";
import { Browser, chromium, Page, Request } from "playwright";
import { fill, Step } from "./scenarios";

/** A user action on a screen: open it, fill fields by their visible label, click a button by its name. */
export interface UiAction {
  goto: string;
  fill?: Record<string, string>;
  click?: string;
}

/** What a UI rule expects after the action. `request` / `noRequest` look like "POST /transfers 201" / "POST /transfers". */
export interface UiExpect {
  /** Text that must be visible after the action; a list means all of them. */
  text?: string | string[];
  request?: string;
  noRequest?: string;
}

export interface UiProbe extends UiAction {
  setup?: Step[];
  expect: UiExpect;
}

export interface ApiCall {
  method: string;
  path: string;
  status: number;
  traceId: string;
  ms: number;
}

export interface UiResult {
  url: string;
  messages: string[];
  requests: ApiCall[];
  consoleErrors: string[];
  /** Everything visible in the page's main area after the action. */
  screenText: string;
}

/** Uses the Chrome named in RE_CHROME_PATH if set, otherwise Playwright's own Chromium. */
export const launchBrowser = (): Promise<Browser> =>
  chromium.launch({ executablePath: process.env.RE_CHROME_PATH || undefined, args: ["--no-sandbox"] });

/**
 * A page whose API calls (fetch and XHR) carry a W3C traceparent header, the way the OpenTelemetry
 * browser SDK would add it. The backend's tracing continues that trace, so each click can be tied
 * to the request it caused and to the SQL behind it.
 */
export async function tracedPage(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const traceOf = new Map<Request, { traceId: string; started: number }>();
  const calls: ApiCall[] = [];
  const consoleErrors: string[] = [];

  await context.route("**/*", async (route) => {
    const req = route.request();
    if (!["fetch", "xhr"].includes(req.resourceType())) return route.continue();
    const traceId = crypto.randomBytes(16).toString("hex");
    traceOf.set(req, { traceId, started: Date.now() });
    await route.continue({ headers: { ...req.headers(), traceparent: `00-${traceId}-${crypto.randomBytes(8).toString("hex")}-01` } });
  });
  page.on("response", (res) => {
    const t = traceOf.get(res.request());
    if (!t) return;
    const url = new URL(res.url());
    calls.push({ method: res.request().method(), path: url.pathname + url.search, status: res.status(), traceId: t.traceId, ms: Date.now() - t.started });
  });
  page.on("console", (m) => {
    // Chrome logs every 4xx/5xx response as "Failed to load resource"; those are API answers, not page errors.
    if (m.type() === "error" && !/favicon/i.test(m.location().url) && !m.text().startsWith("Failed to load resource")) consoleErrors.push(m.text());
  });
  return { page, context, calls, consoleErrors };
}

/** Runs one action and reports what the person would see and which API calls it caused. */
export async function runUiAction(page: Page, calls: ApiCall[], consoleErrors: string[], baseUrl: string, action: UiAction, vars: Record<string, unknown>): Promise<UiResult> {
  const target = fill(action.goto, vars) as string;
  await page.goto("about:blank");
  await page.goto(baseUrl + target);
  await page.waitForLoadState("networkidle");
  for (const [label, value] of Object.entries(fill(action.fill ?? {}, vars) as Record<string, string>)) {
    const field = page.getByLabel(label, { exact: true });
    if ((await field.evaluate((el) => el.tagName)) === "SELECT") {
      const options = await field.locator("option").allTextContents();
      const match = options.find((o) => o.toLowerCase().includes(String(value).toLowerCase()));
      if (!match) throw new Error(`No option containing "${value}" in "${label}"`);
      await field.selectOption({ label: match });
    } else {
      await field.fill(String(value));
    }
  }
  const before = calls.length;
  if (action.click) {
    const button = page.getByRole("button", { name: action.click });
    await ((await button.count()) ? button.first() : page.getByRole("link", { name: action.click }).first()).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(150);
  }
  const messages = (await page.locator('[role="status"], [role="alert"]').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  const main = page.locator("main");
  const screenText = ((await main.count()) ? await main.innerText() : await page.locator("body").innerText()).trim();
  return { url: page.url(), messages, requests: calls.slice(action.click ? before : 0), consoleErrors: [...consoleErrors], screenText };
}

/** Checks a result against a UI rule's expectation. Returns the reasons it failed, empty when it passed. */
export async function checkUi(page: Page, result: UiResult, expect: UiExpect): Promise<string[]> {
  const problems: string[] = [];
  if (expect.text) {
    const visible = await page.locator("body").innerText();
    for (const t of [expect.text].flat()) if (!visible.includes(t)) problems.push(`text not shown: "${t}"`);
  }
  const matches = (spec: string, c: ApiCall) => {
    const [method, path, status] = spec.split(" ");
    return c.method === method && c.path.split("?")[0] === path && (!status || String(c.status) === status);
  };
  if (expect.request && !result.requests.some((c) => matches(expect.request!, c))) problems.push(`no ${expect.request} request`);
  if (expect.noRequest && result.requests.some((c) => matches(expect.noRequest!, c))) problems.push(`unexpected ${expect.noRequest} request`);
  return problems;
}

/** Screenshot cropped to the content (down to the bottom of <main>), so empty space below does not shrink it. */
export async function snap(page: Page, file: string) {
  const bottom = (await page.evaluate(
    `(() => { const m = document.querySelector("main") || document.body; return Math.ceil(m.getBoundingClientRect().bottom + window.scrollY); })()`,
  )) as number;
  const width = page.viewportSize()?.width ?? 1100;
  await page.screenshot({ path: file, type: "jpeg", quality: 75, fullPage: true, clip: { x: 0, y: 0, width, height: Math.min(Math.max(bottom + 24, 240), 1600) } });
}

/** Same screen, different ids: "/#/send/3f2a…" becomes "/#/send/:id". */
export const screenTemplate = (url: string) => {
  const u = new URL(url);
  return (u.pathname + u.hash).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
};

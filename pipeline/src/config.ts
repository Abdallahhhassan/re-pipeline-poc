import fs from "fs";
import path from "path";
import YAML from "yaml";

export interface ServiceConfig {
  /** Where the service answers HTTP. */
  baseUrl: string;
  /** How to start it inside the sandbox. */
  start: { command: string; env?: Record<string, string>; cwd?: string };
  /** Shell command that puts its data back to a known state. */
  reset: { command: string };
}

/** A form the crawler fills in: base values, the button to press, and one field to vary. */
export interface UiForm {
  name: string;
  goto: string;
  fill?: Record<string, string>;
  submit: string;
  vary?: { field: string; values: string[] };
}

export interface UiConfig {
  startPath: string;
  maxScreens: number;
  source?: { dir: string; extensions: string[] };
  forms: UiForm[];
  /** Screens to photograph on both the original and the rebuild, e.g. "/#/send/{{alice}}". */
  compareScreens: string[];
}

export interface Config {
  root: string;
  outDir: string;
  target: ServiceConfig & {
    name: string;
    /** node-auto: inject OpenTelemetry into a Node process. none: no tracing. */
    tracing: "node-auto" | "none";
    database?: { url: string };
    source?: { dir: string; extensions: string[] };
  };
  scenarios: string;
  probes: { fields: string[]; values: unknown[]; dropHeaders: string[] };
  analysis: { model: string; maxTokens: number };
  rebuild: { dir: string; model: string; maxTokens: number };
  rebuilt?: ServiceConfig;
  parity: { ignoreFields: string[]; accepted: { case: string; reason: string }[] };
  site: { links: { label: string; href: string }[] };
  ui?: UiConfig;
}

export function loadConfig(file = "re.config.yaml"): Config {
  const abs = path.resolve(file);
  const root = path.dirname(abs);
  const raw = YAML.parse(fs.readFileSync(abs, "utf8"));
  return {
    root,
    outDir: path.resolve(root, raw.out ?? "out"),
    target: {
      tracing: "node-auto",
      ...raw.target,
      source: raw.target.source
        ? { extensions: [".ts", ".js"], ...raw.target.source, dir: path.resolve(root, raw.target.source.dir) }
        : undefined,
    },
    scenarios: path.resolve(root, raw.scenarios),
    probes: { fields: [], values: [], dropHeaders: [], ...raw.probes },
    analysis: { model: "claude-sonnet-5-5", maxTokens: 16000, ...raw.analysis },
    rebuild: { dir: "rebuilt", model: "claude-sonnet-5-5", maxTokens: 32000, ...raw.rebuild },
    rebuilt: raw.rebuilt,
    parity: { ignoreFields: [], accepted: [], ...raw.parity },
    site: { links: [], ...raw.site },
    ui: raw.ui
      ? {
          maxScreens: 15,
          forms: [],
          compareScreens: [],
          ...raw.ui,
          source: raw.ui.source ? { extensions: [".js", ".html"], ...raw.ui.source, dir: path.resolve(root, raw.ui.source.dir) } : undefined,
        }
      : undefined,
  };
}

export const outPath = (cfg: Config, ...parts: string[]) => {
  const p = path.join(cfg.outDir, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
};

export const writeJson = (file: string, data: unknown) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

export const readJson = <T = any>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));

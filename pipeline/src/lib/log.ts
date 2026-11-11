import fs from "fs";
import path from "path";

/** One file the step read or wrote, with enough of it to see what it holds. */
export interface IO {
  label: string;
  path?: string;
  bytes?: number;
  preview?: string;
}

export interface LogLine {
  ms: number; // since the step started
  level: "info" | "ok" | "warn" | "error";
  msg: string;
}

export interface StepRun {
  step: string;
  n: string;
  title: string;
  does: string;
  status: "ok" | "error";
  startedAt: string;
  ms: number;
  inputs: IO[];
  outputs: IO[];
  lines: LogLine[];
  summary?: unknown;
  error?: string;
}

let current: StepRun | null = null;
let started = 0;
let root = process.cwd();

const PREVIEW_CHARS = 1600;

/** A readable slice of a file: pretty JSON (first items of an array) or the first lines of text. */
function preview(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    try {
      const data = JSON.parse(text);
      const shown = Array.isArray(data) ? data.slice(0, 2) : data;
      const note = Array.isArray(data) && data.length > 2 ? `\n… ${data.length - 2} more items (${data.length} total)` : "";
      const pretty = JSON.stringify(shown, null, 2);
      return (pretty.length > PREVIEW_CHARS ? pretty.slice(0, PREVIEW_CHARS) + "\n…" : pretty) + note;
    } catch {}
  }
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "\n…" : text;
}

function io(label: string, file?: string): IO {
  if (!file) return { label };
  const rel = path.relative(root, file);
  if (!fs.existsSync(file)) return { label, path: rel };
  const stat = fs.statSync(file);
  return { label, path: rel, bytes: stat.size, preview: stat.isFile() ? preview(file) : undefined };
}

function line(level: LogLine["level"], msg: string) {
  const ms = Date.now() - started;
  current?.lines.push({ ms, level, msg });
  const mark = { info: " ", ok: "✓", warn: "!", error: "✗" }[level];
  console.log(`  ${String(ms).padStart(6)}ms ${mark} ${msg}`);
}

export const log = {
  info: (msg: string) => line("info", msg),
  ok: (msg: string) => line("ok", msg),
  warn: (msg: string) => line("warn", msg),
  error: (msg: string) => line("error", msg),
  /** Something the step reads. Pass a file path, or just a label with a short value. */
  input: (label: string, file?: string, value?: string) =>
    current?.inputs.push(value !== undefined ? { label, preview: value } : io(label, file)),
  output: (label: string, file: string) => current?.outputs.push(io(label, file)),
};

export function beginStep(meta: { step: string; n: string; title: string; does: string }, projectRoot: string) {
  root = projectRoot;
  started = Date.now();
  current = { ...meta, status: "ok", startedAt: new Date().toISOString(), ms: 0, inputs: [], outputs: [], lines: [] };
}

/** Closes the step and saves its record to out/runlog/<order>-<step>.json. */
export function endStep(outDir: string, order: number, result: { summary?: unknown; error?: unknown }) {
  if (!current) return;
  current.ms = Date.now() - started;
  current.summary = result.summary;
  if (result.error) {
    current.status = "error";
    current.error = String((result.error as Error)?.stack ?? result.error);
    line("error", String((result.error as Error)?.message ?? result.error));
  }
  const dir = path.join(outDir, "runlog");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(`-${current.step}.json`)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, `${String(order).padStart(2, "0")}-${current.step}.json`), JSON.stringify(current, null, 2));
  current = null;
}

import fs from "fs";
import path from "path";
import { Client } from "pg";
import { Recording } from "./scenarios";

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startMs: number;
  durationMs: number;
  attributes: Record<string, any>;
}

export interface RequestTrace {
  recordingId: string;
  route: string | null;
  spans: number;
  sql: { statement: string; values?: unknown }[];
}

export function readSpans(file: string): Span[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Ties spans to recordings through the traceparent each request carried. */
export function linkTraces(recordings: Recording[], spans: Span[]): RequestTrace[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  return recordings.map((r) => {
    const own = (byTrace.get(r.traceId) ?? []).sort((a, b) => a.startMs - b.startMs);
    // Prefer the SERVER span (kind 1); fall back to the most specific route any span reports.
    const routed =
      own.find((s) => s.kind === 1 && s.attributes["http.route"]) ??
      [...own].sort((a, b) => String(b.attributes["http.route"] ?? "").length - String(a.attributes["http.route"] ?? "").length)[0];
    const sql = own
      .map((s) => ({
        statement: (s.attributes["db.query.text"] ?? s.attributes["db.statement"]) as string | undefined,
        values: s.attributes["db.postgresql.values"],
      }))
      .filter((q): q is { statement: string; values: unknown } => !!q.statement)
      .map((q) => ({ statement: q.statement.replace(/\s+/g, " ").trim(), ...(q.values ? { values: q.values } : {}) }));
    return { recordingId: r.id, route: routed?.attributes["http.route"] ?? null, spans: own.length, sql };
  });
}

/** Tables, columns, keys and checks, read from the live database. */
export async function dumpSchema(url: string): Promise<string> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const cols = await db.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`);
    const cons = await db.query(`
      SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
       ORDER BY 1, 2`);
    const tables = [...new Set(cols.rows.map((r) => r.table_name))];
    return tables
      .map((t) => {
        const c = cols.rows
          .filter((r) => r.table_name === t)
          .map(
            (r) =>
              `| ${r.column_name} | ${r.data_type} | ${r.is_nullable === "YES" ? "yes" : "no"} | ${r.column_default ?? ""} |`,
          );
        const k = cons.rows.filter((r) => r.table_name === t).map((r) => `- ${r.conname}: ${r.def}`);
        return [`### ${t}`, "| column | type | nullable | default |", "| --- | --- | --- | --- |", ...c, "", ...k].join("\n");
      })
      .join("\n\n");
  } finally {
    await db.end();
  }
}

/**
 * Picks the source files behind the observed routes: files that mention a route string,
 * plus everything they import (relative imports, followed transitively).
 */
export function sliceSource(dir: string, extensions: string[], routes: string[]) {
  const all = walk(dir).filter((f) => extensions.includes(path.extname(f)));
  const picked = new Set<string>();
  const queue = all.filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    return routes.some((r) => src.includes(`"${r}"`) || src.includes(`'${r}'`) || src.includes("`" + r + "`"));
  });
  while (queue.length) {
    const f = queue.shift()!;
    if (picked.has(f)) continue;
    picked.add(f);
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:from\s+|require\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = path.resolve(path.dirname(f), m[1]);
      const hit = [base, ...extensions.map((e) => base + e)].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (hit) queue.push(hit);
    }
  }
  return [...picked].sort().map((f) => ({ file: path.relative(process.cwd(), f), content: fs.readFileSync(f, "utf8") }));
}

/** Every source file under dir, for small front ends where the whole thing is the evidence. */
export function allSource(dir: string, extensions: string[]) {
  return walk(dir)
    .filter((f) => extensions.includes(path.extname(f)))
    .sort()
    .map((f) => ({ file: path.relative(process.cwd(), f), content: fs.readFileSync(f, "utf8") }));
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(p);
    return [p];
  });
}

export const numbered = (content: string) =>
  content
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
    .join("\n");

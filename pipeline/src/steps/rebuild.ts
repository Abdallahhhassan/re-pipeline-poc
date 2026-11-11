import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { Config, outPath, writeJson } from "../config";
import { askClaude, extractJson, hasApiKey } from "../lib/claude";
import { log } from "../lib/log";
import { claudeTool } from "../lib/tools";

const SYSTEM = `You are the builder in a clean-room rebuild. You never see the original source code.
You get a behavior spec, the observed API contract, open questions, and an acceptance suite of
HTTP probes that the original system passes.

Write a new service that satisfies the spec and passes every probe, designed your own way:
your own names, structure and database schema.

Constraints:
- TypeScript, Express 5, pg. Listen on process.env.PORT, connect with process.env.DATABASE_URL.
- Files: package-free (dependencies are already installed one level up), tsconfig.json compiling src/ to dist/
  as CommonJS, src/server.ts as the entry point, schema.sql that drops and recreates your tables,
  DECISIONS.md listing how you answered each open question.
- Match the contract exactly where clients can see it: paths, status codes, JSON field names and value
  formats (for example money as two-decimal strings), error codes, response headers.
Reply with JSON only: { "files": [ { "path": "src/server.ts", "content": "..." } ] }`;

const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

function builderInput(cfg: Config, fix: boolean) {
  const parts = [
    `## Behavior spec\n${read(outPath(cfg, "spec", "spec.md"))}`,
    `## Observed API contract (JSON)\n${read(outPath(cfg, "spec", "contract.json"))}`,
    `## Acceptance suite (probes the original passes)\n${read(outPath(cfg, "verify", "suite.json"))}`,
  ];
  if (fix) {
    const dir = path.resolve(cfg.root, cfg.rebuild.dir);
    const files = listFiles(dir).filter((f) => !f.includes("dist/"));
    parts.push(`## Parity differences to fix\n${read(outPath(cfg, "parity", "diffs-for-builder.md"))}`);
    parts.push(`## Your current files\n${files.map((f) => `### ${f}\n\`\`\`\n${read(path.join(dir, f))}\n\`\`\``).join("\n\n")}`);
    parts.push("Return the full content of every file you change.");
  }
  return parts.join("\n\n");
}

function listFiles(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "dist" ? [] : listFiles(path.join(dir, e.name), path.join(base, e.name))) : [path.join(base, e.name)],
  );
}

/**
 * Step 9. The builder sees the spec, contract and acceptance suite only, never the original code.
 * --fix sends the latest parity differences back to the builder (the step 9 <-> 10 loop).
 */
export async function rebuild(cfg: Config, flags: Set<string>) {
  const fix = flags.has("--fix");
  const input = builderInput(cfg, fix);
  const promptFile = outPath(cfg, "rebuild", fix ? "fix-prompt.md" : "prompt.md");
  fs.writeFileSync(promptFile, `<!-- system -->\n${SYSTEM}\n\n<!-- user -->\n${input}\n`);
  const dir = path.resolve(cfg.root, cfg.rebuild.dir);
  log.input("Behavior spec", outPath(cfg, "spec", "spec.md"));
  log.input("Observed API contract", outPath(cfg, "spec", "contract.json"));
  log.input("Acceptance suite", outPath(cfg, "verify", "suite.json"));
  if (fix) log.input("Parity differences to fix", outPath(cfg, "parity", "diffs-for-builder.md"));
  log.info("clean room: the builder prompt holds the spec, contract and probes only, never the original source");
  log.output("Builder prompt", promptFile);

  if (flags.has("--manual") || !hasApiKey()) {
    log.tool({ name: "Manual build", purpose: "with no API key, a person or a Claude chat writes the service from the prompt", where: "out/rebuild/prompt.md" });
    log.warn(`manual mode: write the service into ${cfg.rebuild.dir}/ from the prompt`);
    return { mode: "manual", prompt: path.relative(cfg.root, promptFile), note: `write the service into ${cfg.rebuild.dir}/ from this prompt` };
  }
  log.tool(claudeTool(cfg, cfg.rebuild.model));
  log.tool({ name: "TypeScript compiler (tsc)", purpose: "checks and builds the files the builder wrote", where: "rebuilt/tsconfig.json" });
  log.info(`calling Claude (${cfg.rebuild.model}) as the builder`);
  const reply = await askClaude({ model: cfg.rebuild.model, maxTokens: cfg.rebuild.maxTokens, system: SYSTEM, user: input });
  const { files } = extractJson<{ files: { path: string; content: string }[] }>(reply);
  for (const f of files) {
    const target = path.resolve(dir, f.path);
    if (!target.startsWith(dir + path.sep)) throw new Error(`Refusing to write outside ${dir}: ${f.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
  writeJson(outPath(cfg, "rebuild", "written.json"), files.map((f) => f.path));
  log.ok(`wrote ${files.length} files: ${files.map((f) => f.path).join(", ")}`);
  log.output("Files the builder wrote", outPath(cfg, "rebuild", "written.json"));
  execSync(`npx tsc -p ${path.join(cfg.rebuild.dir, "tsconfig.json")}`, { cwd: cfg.root, stdio: "inherit" });
  return { mode: "api", filesWritten: files.length };
}

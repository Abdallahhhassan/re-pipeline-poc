import { spawn, execSync, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { Config, ServiceConfig } from "../config";
import { log } from "./log";

const REGISTER = path.resolve(__dirname, "../otel/register.cjs");

export interface Running {
  stop(): Promise<void>;
  logFile: string;
}

/** Runs a shell command from the project root (used for DB resets). */
export function sh(cfg: Config, command: string, opts: { quiet?: boolean } = {}) {
  if (!opts.quiet) log.info(`reset data: ${command.replace(/\s*2>\/dev\/null$/, "")}`);
  execSync(command, { cwd: cfg.root, stdio: ["ignore", "ignore", "pipe"], shell: "/bin/bash" });
}

/** Starts a service in the sandbox, optionally with OpenTelemetry injected, and waits until it answers. */
export async function startService(
  cfg: Config,
  svc: ServiceConfig,
  opts: { label: string; traceFile?: string },
): Promise<Running> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(svc.start.env ?? {}) };
  if (opts.traceFile) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require ${REGISTER}`.trim();
    env.RE_TRACE_FILE = opts.traceFile;
    env.RE_SERVICE_NAME = opts.label;
  }
  // A leftover process on the same port would answer instead of this one (and without tracing).
  const busy = await fetch(svc.baseUrl + "/", { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  if (busy) throw new Error(`${svc.baseUrl} already answers before ${opts.label} started. Stop the old process on that port first.`);
  log.info(`start ${opts.label}: ${svc.start.command}${opts.traceFile ? " with OpenTelemetry injected (NODE_OPTIONS=--require register.cjs)" : ""}`);
  const t0 = Date.now();
  const logFile = path.join(cfg.outDir, "logs", `${opts.label}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "w");
  const child: ChildProcess = spawn("bash", ["-c", svc.start.command], {
    cwd: path.resolve(cfg.root, svc.start.cwd ?? "."),
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${opts.label} exited early, see ${logFile}`);
    }
    try {
      await fetch(svc.baseUrl + "/", { signal: AbortSignal.timeout(500) });
      log.ok(`${opts.label} answering on ${svc.baseUrl} after ${Date.now() - t0}ms`);
      break; // any HTTP answer means it is up
    } catch {
      if (Date.now() > deadline) throw new Error(`${opts.label} did not start, see ${logFile}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return {
    logFile,
    stop: () =>
      new Promise<void>((resolve) => {
        log.info(`stop ${opts.label}`);
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          resolve();
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
          resolve();
        }, 3000);
      }),
  };
}

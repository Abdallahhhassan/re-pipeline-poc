import { Config, ServiceConfig } from "../config";
import { Tool } from "./log";

/** The reset command is configurable; name the program it runs (psql for the demo). */
export const resetTool = (svc: ServiceConfig): Tool => ({
  name: svc.reset.command.trim().split(/\s+/)[0],
  purpose: "puts the database back to a known state before each run and each test",
  where: "reset.command in re.config.yaml",
});

export const requestTool: Tool = {
  name: "Node fetch",
  purpose: "sends each request and records the response; adds a traceparent header so traces can be matched to it",
  where: "pipeline/src/lib/scenarios.ts",
};

export const processTool: Tool = {
  name: "Node child_process",
  purpose: "starts and stops the service under test",
  where: "pipeline/src/lib/proc.ts",
};

export const claudeTool = (cfg: Config, model: string): Tool => ({
  name: `Claude API (${model})`,
  purpose: "reads the evidence and writes the result as JSON",
  where: "pipeline/src/lib/claude.ts",
  link: "https://docs.claude.com",
});

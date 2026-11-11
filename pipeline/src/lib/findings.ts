import { UiProbe } from "./browser";
import { RequestSpec, Step } from "./scenarios";

export type Tag = "Seen" | "Inferred" | "Unknown";

export interface Probe {
  /** Extra steps after the fixtures, e.g. make a first transfer before testing a retry. */
  setup?: Step[];
  request: RequestSpec;
  expect: { status: number; body?: unknown; headers?: Record<string, string> };
}

export interface Finding {
  id: string;
  area: string;
  route: string; // "POST /transfers", or "UI /#/send/:id" for a screen
  kind: "rule" | "flow" | "data" | "error" | "contract" | "screen";
  claim: string;
  tag: Tag;
  evidence: string[];
  probe?: Probe;
  /** For UI rules: run in a real browser instead of an HTTP call. */
  uiProbe?: UiProbe;
}

export interface Unknown {
  id: string;
  area: string;
  question: string;
  why: string;
  evidence?: string[];
}

export interface Analysis {
  findings: Finding[];
  unknowns: Unknown[];
}

export const FINDINGS_SCHEMA = `{
  "findings": [
    {
      "id": "F1",
      "route": "POST /transfers",
      "kind": "rule | flow | data | error | contract",
      "claim": "One plain-language sentence about behavior.",
      "tag": "Seen | Inferred | Unknown",
      "evidence": ["probe-014", "trace:flow-005", "src:demo-target/src/policy.ts:12"],
      "probe": {
        "setup": [ { "name": "optional extra step", "request": { "method": "POST", "path": "/x", "body": {} }, "save": { "var": "body.id" } } ],
        "request": { "method": "POST", "path": "/transfers", "headers": {}, "body": { "fromWalletId": "{{alice}}" } },
        "expect": { "status": 422, "body": { "error": "LIMIT_EXCEEDED" }, "headers": {} }
      }
    }
  ],
  "unknowns": [ { "id": "U1", "question": "...", "why": "...", "evidence": ["src:..."] } ]
}`;

export const UI_FINDINGS_SCHEMA = `{
  "findings": [
    {
      "id": "F1",
      "route": "UI /#/send/:id",
      "kind": "screen | rule | flow | error",
      "claim": "One plain-language sentence about what the person sees or can do.",
      "tag": "Seen | Inferred | Unknown",
      "evidence": ["ui:ui-003", "ui:screen-02", "src:demo-target/public/app.js:71"],
      "uiProbe": {
        "setup": [ { "name": "optional API step before the page opens", "request": { "method": "POST", "path": "/x", "body": {} } } ],
        "goto": "/#/send/{{alice}}",
        "fill": { "Amount": "0" },
        "click": "Send money",
        "expect": { "text": ["Enter an amount above 0."], "request": "POST /transfers 201", "noRequest": "POST /transfers" }
      }
    }
  ],
  "unknowns": [ { "id": "U1", "question": "...", "why": "...", "evidence": ["src:..."] } ]
}`;

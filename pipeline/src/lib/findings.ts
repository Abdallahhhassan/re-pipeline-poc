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
  route: string; // "POST /transfers"
  kind: "rule" | "flow" | "data" | "error" | "contract";
  claim: string;
  tag: Tag;
  evidence: string[];
  probe?: Probe;
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

/*
 * Tracing bootstrap injected into a Node target with:
 *   NODE_OPTIONS="--require <this file>"   and   RE_TRACE_FILE=<path.jsonl>
 * No code changes to the target. Every finished span is appended to the JSONL file.
 * Non-Node targets: point their OpenTelemetry exporter at a collector instead (see README).
 */
const fs = require("fs");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { SimpleSpanProcessor } = require("@opentelemetry/sdk-trace");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");

const file = process.env.RE_TRACE_FILE || "traces.jsonl";

class JsonlFileExporter {
  export(spans, done) {
    const lines = spans.map((s) => {
      const ctx = s.spanContext();
      const parent = s.parentSpanContext ? s.parentSpanContext.spanId : s.parentSpanId;
      return JSON.stringify({
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: parent || null,
        name: s.name,
        kind: s.kind,
        startMs: s.startTime[0] * 1e3 + s.startTime[1] / 1e6,
        durationMs: s.duration[0] * 1e3 + s.duration[1] / 1e6,
        status: s.status,
        attributes: s.attributes,
      });
    });
    fs.appendFileSync(file, lines.join("\n") + "\n");
    done({ code: 0 });
  }
  shutdown() {
    return Promise.resolve();
  }
}

const sdk = new NodeSDK({
  serviceName: process.env.RE_SERVICE_NAME || "target",
  spanProcessors: [new SimpleSpanProcessor({ exporter: new JsonlFileExporter() })],
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
      "@opentelemetry/instrumentation-pg": { enhancedDatabaseReporting: true },
    }),
  ],
});
sdk.start();
// Spans are written as each one ends, so nothing is left to flush: exit at once.
process.on("SIGTERM", () => process.exit(0));

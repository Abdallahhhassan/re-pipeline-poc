# Generalizing the pipeline: tools, effort and cost

For a typical stack (one language, one SQL database, HTTP APIs and a web UI), generalizing takes
about 4 to 6 weeks of one developer and costs roughly $50 to $200 a month to run.

Everything after capture (analyze, verify, spec, rebuild, rebuild check) only reads four files and
talks HTTP: `out/capture/recordings.json`, `traces.json`, `schema.md` and `code-slice.md`. To support
a new stack, swap each capture tool for an adapter that writes the same files, chosen in
`re.config.yaml`. Nothing downstream changes.

## What each step uses now, and the general version

| Step | PoC uses now | General version | What it unlocks |
| --- | --- | --- | --- |
| Trace | OTel Node SDK, spans written to a file | OTel zero-code agents for Java, Python, .NET and Go, sending to an OTel Collector that writes JSON | Any language; the `traceparent` header is a W3C standard, so request matching works the same |
| Record | Built-in recorder (only sees requests the pipeline sends) | Keploy (eBPF), or HAR files from browser sessions | Real user traffic, plus DB and queue calls, with no code changes |
| Crawl | Hand-written scenarios | Playwright crawler, HAR, then scenarios | Journeys discovered through the real UI |
| Data | Postgres `information_schema` | SchemaSpy or tbls for the schema; Debezium for what each flow writes | MySQL, SQL Server, Oracle, Mongo; exact writes per flow |
| Code | Route-string search + JS imports | tree-sitter or CodeQL call graphs; Ghidra or REA for binaries | Any language, and compiled parts with no source |
| Rebuild check | Built-in differ on API responses | GoReplay mirroring real traffic to both, plus a database-state diff | Production-like checks and hidden data differences |

## Effort per adapter

One developer who knows the target stack. These are estimates, not measurements.

| Adapter | Effort | Main difficulty |
| --- | --- | --- |
| OTel Collector (any language) | 2 to 4 days | Installing the agent in each service; trace headers lost at gateways or queues |
| HAR import | 1 to 2 days | Removing noise (analytics, static files) |
| Keploy recording | 3 to 5 days | Needs a Linux host with eBPF and root; filtering flaky fields |
| Schema (SchemaSpy or tbls) | 1 to 2 days | Database access from the sandbox |
| Debezium writes per flow | About 1 week | Running Kafka or Debezium Server; matching changes to requests |
| Code index (tree-sitter) | 1 to 2 weeks | Finding routes in each framework's own style |
| Playwright crawler | 1 to 2 weeks | Logins, forms, and never clicking anything destructive |
| GoReplay mirror + DB diff | About 1 week | Running both systems on identical data |
| Auth, secrets, stubs for email and payments | 1 to 2 weeks | Specific to each system |
| Hardening (cost limits, batching, retries, splitting big areas) | About 1 week | Keeping prompts small on a large codebase |

A typical first target needs the Collector, HAR or Keploy, schema, code index and auth adapters:
about 4 to 6 weeks. All adapters together: about 2 to 3 months.

## Running costs

Prices as of November 2026. Real-system numbers are estimates.

| Item | Demo | Real system | Notes |
| --- | --- | --- | --- |
| Claude API, analysis (Sonnet 5.5: $2 in, $10 out per million tokens) | About $0.10 to $0.15 a run (about 10k tokens in, 7k out) | About $1 to $5 a full run (12 areas of about 40k tokens in, 10k out) | The Batch API halves it for unattended runs |
| Claude API, rebuild | About $0.10 | About $10 to $30 per rebuild, including 2 to 3 fix rounds | Only when you rebuild, not every run |
| GitHub Actions | $0: public repos are free; a run is about 1 minute | Private repo on GitHub Free: $12 of compute a month included (about 2,000 Linux minutes), then $0.006 a minute; heavier runs take 15 to 30 minutes | Self-hosted runners avoid the minute charge |
| Sandbox | $0: runs inside the Actions runner | A VM that can reach company services and masked data, roughly $50 to $150 a month | Depends on size and whether it runs only during the pipeline |
| Tool licenses | $0 | $0 with the open-source set | Paid only if chosen: CodeQL on private code needs GitHub Code Security ($30 per active committer a month); Keploy production recording, GoReplay Pro and IDA Pro are paid tiers |

Open-source set, $0 in licenses: OpenTelemetry, Playwright, SchemaSpy, tbls, Debezium, tree-sitter,
Ghidra, REA, and the open-source editions of Keploy and GoReplay.

Without an API key, the AI steps can also run on a Claude subscription through Claude Code
(`claude -p` locally, or a `CLAUDE_CODE_OAUTH_TOKEN` secret in Actions), which draws from the plan's
limits instead of API billing.

Sources: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[GitHub Advanced Security pricing (Redress Compliance)](https://redresscompliance.com/microsoft-github-advanced-security-licensing),
[Keploy](https://github.com/keploy/keploy).

# Reverse engineering pipeline: proof of concept

A thin, working slice of the automated pipeline from the
[pipeline whiteboard](https://claude.ai/artifact/4ekdowofD1WPxMS9YTo3py) and the
[research doc](https://claude.ai/artifact/EgHqL2KpGp4eGMsZDHSZbd).

It works on any HTTP service described in one file, `re.config.yaml`. Until we have access to our
own system, it runs against `demo-target/`, a small wallet service built only as a stand-in.

**Rule of the pipeline:** tools capture, AI explains, tests verify, people decide.
Nothing is marked *Seen* unless a probe proved it on the sandbox.

## What each step does

| Whiteboard step | Command | What it does | Output |
| --- | --- | --- | --- |
| 0 Sandbox | `make setup` | Local databases; every step resets data with `reset.command` | |
| 1 Trace | `capture` | Injects OpenTelemetry into the target with no code changes, ties each request to its spans and SQL through a `traceparent` header | `out/capture/traces.json` |
| 2 Record | `capture` | Runs the scenarios, then probes each configured field one value at a time from a fresh state | `out/capture/recordings.json` |
| 4 Data | `capture` | Reads tables, columns and constraints from the live database | `out/capture/schema.md` |
| 5 Index code | `capture` | Picks the source files behind the observed routes and follows their imports | `out/capture/code-slice.md` |
| 6 Analyze | `analyze` | One Claude call per area (`/wallets`, `/transfers`); findings tagged Seen, Inferred or Unknown, each with evidence and a probe | `out/analysis/findings.json` |
| 7 Verify | `verify` | Runs every probe on a fresh sandbox. Pass = Seen, fail = refuted, no probe = Inferred. Routes nobody explained become unknowns | `out/verify/*` |
| 8 Spec | `spec` | Verified behavior, the observed API contract, open questions | `out/spec/spec.md`, `contract.json` |
| 9 Rebuild | `rebuild` | Clean room: the builder gets the spec, contract and probe suite, never the original code | `rebuilt/` |
| 10 Parity | `parity` | Replays journeys, probes and verified claims on both services from identical states and diffs what clients see | `out/parity/report.md` |
| Report | `report` | One page: proven, refuted, unknowns, parity | `out/report.md` |
| UI | `site` | Self-contained results page: how each step ran (inputs, outputs, logs), findings, unknowns, parity, traffic, contract | `site/index.html` |

Not in this slice: step 3 (Playwright crawler; scenarios are written by hand in `scenarios/demo.yaml`).

Every step also writes its own record to `out/runlog/`: what it does, the files it read and wrote
(with previews), timings, and every log line. The results page shows them in order, so you can follow
one run from the first request to the parity diff.

## Run it

Needs Node 22+ and Postgres 16 (`psql` on the path).

```bash
make setup                 # install, build the demo target, create re_demo and re_rebuilt
export ANTHROPIC_API_KEY=… # optional: without it, AI steps run in manual mode
make re-pipeline           # capture -> analyze -> verify -> spec -> parity -> report
make rebuild               # builder writes rebuilt/ from the spec, then parity
make fix                   # sends parity differences back to the builder
make step S=verify         # any single step
```

**Manual mode** (no key, or `--manual`): `analyze` writes `out/analysis/<area>/prompt.md`, and you
or a Claude session write `findings.json` next to it. `rebuild` writes `out/rebuild/prompt.md`.
Everything after that is automatic.

**Nightly:** `.github/workflows/re-pipeline.yml` runs the whole thing with a Postgres service,
uploads `out/`, posts `out/report.md` to the run summary, and deploys `site/` to GitHub Pages.
Add `ANTHROPIC_API_KEY` as a repo secret, and set Settings → Pages → Source to "GitHub Actions".

## Pointing it at our system

Edit `re.config.yaml`:

| Key | Set it to |
| --- | --- |
| `target.baseUrl`, `target.start` | How to start the service in the sandbox and where it answers |
| `target.reset.command` | A command that restores a known data state (sandbox only, it wipes data) |
| `target.database.url` | A read connection for the schema dump |
| `target.source` | Source folder and file extensions, if we have the code |
| `target.tracing` | `node-auto` for Node services, `none` otherwise (recordings and probes still work) |
| `scenarios` | Real user journeys, with `save:` for ids and `probe: true` on steps to explore |
| `probes` | Fields to vary and the values to try |
| `parity.ignoreFields` | Fields that change every run (ids, timestamps) |
| `parity.accepted` | Differences people reviewed and chose not to copy |

Never point it at production: `reset.command` destroys data, and probes create real records.

## Results on the demo target

| Measure | Value |
| --- | --- |
| Requests recorded | 22 (4 fixtures, 7 journey steps, 11 probes) |
| Findings | 28 |
| Proven by a probe (Seen) | 27 (the remaining one is a ledger detail with no HTTP probe) |
| Open unknowns for people | 5, e.g. "How does a pending_review transfer get approved?" |
| Parity | 48 of 49 cases match; 1 accepted difference |

The one difference is a real bug parity caught in the original: it rejects some valid amounts such
as 4.35, because `4.35 * 100` is `434.99999999999994` in JavaScript. The rebuild uses integer cents
and accepts them, recorded in `re.config.yaml` under `parity.accepted` and in `rebuilt/DECISIONS.md`.

The verifier was also checked with a deliberately wrong claim (minimum fee 0.99): it was refuted
and dropped back to Inferred.

## Honest limits of this PoC

- In this run the analysis (step 6) and the rebuild (step 9) were done by Claude in a chat session,
  in manual mode. The API path was tested against a local stand-in, not the real API.
- The same session also wrote the demo target, so the clean room is not real for the demo. With
  real access, the API scripts keep it: the builder call only ever receives the spec.
- Lighter stand-ins: a built-in recorder and replayer instead of Keploy and GoReplay (those need
  root and kernel features); API-level parity only, no database-state diff.
- Tracing injection works for CommonJS Node services. ESM Node, Java, .NET or Python services need
  their own OpenTelemetry agent exporting to a collector.
- No cost controls yet: each area is one call, and large areas should be split further.

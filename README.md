# Reverse engineering pipeline: proof of concept

A thin, working slice of the automated pipeline from the
[pipeline whiteboard](https://claude.ai/artifact/4ekdowofD1WPxMS9YTo3py) and the
[research doc](https://claude.ai/artifact/EgHqL2KpGp4eGMsZDHSZbd).

It works on any HTTP service, and its web screens, described in one file, `re.config.yaml`. Until we
have access to our own system, it runs against `demo-target/`, a small wallet service with two screens
(a wallets list and a send-money form) built only as a stand-in.

**Rule of the pipeline:** tools capture, AI explains, tests verify, people decide.
Nothing is marked *Seen* unless a probe proved it on the sandbox.

## What each step does

| Whiteboard step | Command | What it does | Output |
| --- | --- | --- | --- |
| 0 Sandbox | `make setup` | Local databases; every step resets data with `reset.command` | |
| 1 Trace | `capture` | Injects OpenTelemetry into the target with no code changes, ties each request to its spans and SQL through a `traceparent` header | `out/capture/traces.json` |
| 2 Record | `capture` | Runs the scenarios, then probes each configured field one value at a time from a fresh state | `out/capture/recordings.json` |
| 3 Crawl | `crawl` | Playwright opens the app in Chrome, follows links from the start page, and fills each configured form with one value changed per try, on fresh data. Every API call the page makes gets a `traceparent`, so each click links to its backend route and SQL | `out/ui/screens.json`, `interactions.json`, screenshots |
| 4 Data | `capture` | Reads tables, columns and constraints from the live database | `out/capture/schema.md` |
| 5 Index code | `capture` | Picks the source files behind the observed routes and follows their imports | `out/capture/code-slice.md` |
| 6 Analyze | `analyze` | One Claude call per area (`/wallets`, `/transfers`, and `ui` for the screens); findings tagged Seen, Inferred or Unknown, each with evidence and a probe | `out/analysis/findings.json` |
| 7 Verify | `verify` | Runs every probe on a fresh sandbox: HTTP probes as requests, UI probes as clicks in Chrome (open, fill by label, click, check the text shown and the API calls). Pass = Seen, fail = refuted, no probe = Inferred. Routes and screens nobody explained become unknowns | `out/verify/*` |
| 8 Spec | `spec` | Verified behavior, the observed API contract, open questions | `out/spec/spec.md`, `contract.json` |
| 9 Rebuild | `rebuild` | Clean room: the builder gets the spec, contract and probe suite, never the original code | `rebuilt/` |
| 10 Parity | `parity` | Replays journeys, probes, verified claims and every UI form try on both services from identical states, diffs what clients and people see, and saves screenshots side by side | `out/parity/report.md` |
| Report | `report` | One page: proven, refuted, unknowns, parity | `out/report.md` |
| UI | `site` | Self-contained results page: how each step ran (inputs, outputs, logs), findings, unknowns, parity, traffic, contract | `site/index.html` |

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
make app                   # the original app on http://127.0.0.1:4001, for a live demo
make app-rebuilt           # the rebuilt app on http://127.0.0.1:4002
```

The UI steps use Playwright's Chromium (`npx playwright install chromium`, done by `make setup`). To use
an installed Chrome instead, set `RE_CHROME_PATH=/path/to/chrome`.

**Manual mode** (no key, or `--manual`): `analyze` writes `out/analysis/<area>/prompt.md`, and you
or a Claude session write `findings.json` next to it. `rebuild` writes `out/rebuild/prompt.md`.
Everything after that is automatic.

**In GitHub Actions:** `.github/workflows/re-pipeline.yml` runs the whole thing on every push to `main`
and on demand (Actions → re-pipeline → Run workflow), with a Postgres service. It uploads `out/`, posts
`out/report.md` to the run summary, and deploys `site/` to GitHub Pages. There is no nightly schedule
while it points at the demo; add one back when it points at a system that changes.
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
| `ui` | Start page, forms to try (fields by visible label, the button to press, one field to vary) and screens to compare. Leave it out for API-only systems |
| `parity.ignoreFields` | Fields that change every run (ids, timestamps) |
| `parity.accepted` | Differences people reviewed and chose not to copy |

Never point it at production: `reset.command` destroys data, and probes create real records.

## Results on the demo target

| Measure | Value |
| --- | --- |
| Requests recorded | 22 (4 fixtures, 7 journey steps, 11 probes) |
| UI crawl | 2 screens, 9 form tries, 15 of 15 page API calls traced to route and SQL |
| Findings | 44 (28 API, 16 UI) |
| Proven by a probe (Seen) | 42; 1 refuted, 1 ledger detail with no outside test |
| Open unknowns for people | 7, e.g. "How does a pending_review transfer get approved?" |
| Parity | 71 of 75 cases match; 4 accepted differences, 0 open |

What the run found that is worth showing:

- **A float bug in the original API.** It rejects some valid amounts such as 4.35, because
  `4.35 * 100` is `434.99999999999994` in JavaScript. On the screen this shows up as a generic
  "Check the amount and try again." The rebuild uses integer cents and accepts them.
- **The screen and the API disagree on the fee.** The send screen previews the fee with its own
  copy of the rule and different rounding: for 205.00 it previews 1.02, the API charges 1.03. Only
  the UI crawl can see this, because the API alone is consistent. The rebuild previews exactly what
  the API charges.
- **An endpoint no API scenario used.** `GET /wallets` was found because the wallets screen calls it.
- **A wrong guess caught.** The UI analysis guessed the amount field accepts "1,000" because the
  screen shows money that way. Its browser test failed, so the claim is marked refuted and the spec
  tells the builder not to build it.

All four differences are recorded in `re.config.yaml` under `parity.accepted` and in
`rebuilt/DECISIONS.md`.

## Generalizing to other stacks

[docs/GENERALIZING.md](docs/GENERALIZING.md) maps each step to the open-source tool that replaces the
built-in one, with effort per adapter and running costs.

## Honest limits of this PoC

- In this run the analysis (step 6) and the rebuild (step 9) were done by Claude in a chat session,
  in manual mode. The API path was tested against a local stand-in, not the real API.
- The same session also wrote the demo target, so the clean room is not real for the demo. With
  real access, the API scripts keep it: the builder call only ever receives the spec.
- Lighter stand-ins: a built-in recorder and replayer instead of Keploy and GoReplay (those need
  root and kernel features); no database-state diff.
- The crawler covers what a small app needs: links, one form at a time, one value varied per try.
  A real app adds logins, many forms, and a list of buttons it must never press.
- The browser side of tracing is emulated: Playwright adds the `traceparent` header to the page's
  API calls, as the OpenTelemetry browser SDK would if it were in the app.
- Tracing injection works for CommonJS Node services. ESM Node, Java, .NET or Python services need
  their own OpenTelemetry agent exporting to a collector.
- No cost controls yet: each area is one call, and large areas should be split further.

# Status

Snapshot of what's known to work end-to-end against the live OneShot API. Updated manually after each dogfood run; CI auto-update is on the Phase 3 roadmap.

Last manual update: **2026-04-23** · Bun **1.3.13** · OneShot SDK **0.15.0**

---

## CLI surfaces

| Group    | Command                          | State    | Notes                                                                             |
| -------- | -------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `init`   | `oneshot-gtm init`               | ✅ green | First-run wizard with hidden-input keys; saves to `~/.oneshot-gtm/.env` chmod 600 |
| `doctor` | `oneshot-gtm doctor`             | ✅ green | Reports wallet balance, key sources, ledger integrity                             |
| `ui`     | `oneshot-gtm ui`                 | ✅ green | Boots `apps/server`, opens browser to `http://127.0.0.1:3030`                     |
| `config` | llm / founder / keys / telemetry | ✅ green | All four subcommands round-trip to disk                                           |

## `discover`

| Command              | State       | OneShot calls         | Notes                                                                                             |
| -------------------- | ----------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `icp interview-prep` | ✅ green    | LLM only              | Multi-input: arg / `--from-file` / `--stdin` / interactive                                        |
| `icp synthesize`     | ✅ green    | LLM only              | Reads `.txt`/`.md`/`.json` from a directory                                                       |
| `pmf classify`       | ✅ green    | LLM only              | Sequoia Arc + Four Fits                                                                           |
| `pmf survey`         | ⚠️ untested | Build + email + inbox | Requires OneShot Build endpoint to be live; landing page deploys but not yet exercised end-to-end |
| `pmf survey-collect` | ⚠️ untested | inbox + LLM           | Depends on actual replies in your OneShot inbox                                                   |

## `motion` (10 plays)

| Play                | State       | OneShot calls                        | Cadence steps                             |
| ------------------- | ----------- | ------------------------------------ | ----------------------------------------- |
| `show-hn`           | ✅ green    | enrich + research + email            | one-touch (no follow-up)                  |
| `job-change`        | ✅ green    | enrich + research + email            | day-5 follow-up + day-14 breakup          |
| `post-funding`      | ✅ green    | enrich + research + email            | day-9 follow-up + day-18 breakup          |
| `accelerator-batch` | ✅ green    | enrich + (research?) + email         | day-5 single follow-up + breakup          |
| `concierge`         | ⚠️ untested | voice + email                        | Requires real phone number for full test  |
| `demo-no-show`      | ⚠️ untested | sms + email                          | Requires real phone number for SMS leg    |
| `competitor-switch` | ⚠️ untested | enrich + browser + email             | Browser scrape against G2/BuiltWith       |
| `hiring-signal`     | ⚠️ untested | enrich + websearch + webread + email | Web search against Lever/Greenhouse/Ashby |
| `podcast-guest`     | ✅ green    | enrich + websearch + email           | Single touch, no follow-up                |
| `breakup-revive`    | ✅ green    | email only                           | Pulls from `listColdProspects`            |

## `cadence`

| Command           | State    | Notes                                            |
| ----------------- | -------- | ------------------------------------------------ |
| `cadence advance` | ✅ green | Polls inbox; marks replies; fires due follow-ups |
| `cadence list`    | ✅ green | `--all` includes replied/breakup/completed       |
| `cadence stop`    | ✅ green | Per-play or all-for-prospect                     |

## `intel`

| Command                | State       | Notes                                                      |
| ---------------------- | ----------- | ---------------------------------------------------------- |
| `intel advise`         | ✅ green    | Loops with conversation memory; cites bracketed principles |
| `intel personalize`    | ✅ green    | Anti-slop linter on the first line                         |
| `intel triage-replies` | ⚠️ untested | Requires inbound replies to triage                         |
| `intel weekly-review`  | ✅ green    | Generates Monday narrative from ledger                     |

## `handoff`

| Command              | State                                    |
| -------------------- | ---------------------------------------- |
| `handoff readiness`  | ✅ green                                 |
| `handoff templatize` | ✅ green (soft-gated, --force overrides) |
| `handoff first-ae`   | ✅ green                                 |

## `measure`

| Command                | State    |
| ---------------------- | -------- |
| `measure receipt <id>` | ✅ green |
| `measure cac`          | ✅ green |
| `measure rocs`         | ✅ green |
| `measure outcome`      | ✅ green |

## Web dashboard (`apps/web`)

| Route                    | State                                             |
| ------------------------ | ------------------------------------------------- |
| `/` (Home)               | ✅ green                                          |
| `/cadences`              | ✅ green (with stop + log-outcome actions)        |
| `/receipts`              | ✅ green (with signed-receipt modal)              |
| `/plays`                 | ✅ green (with run + copy-CLI buttons)            |
| `/measure`               | ✅ green                                          |
| `/setup`                 | ✅ green (editable wizard with hidden-input keys) |
| `/run/show-hn`           | ✅ green (SSE-streamed drafts)                    |
| `/run/job-change`        | ✅ green (SSE-streamed drafts)                    |
| `/run/accelerator-batch` | ✅ green (SSE-streamed drafts)                    |

## Server (`apps/server`)

| Route                                         | State                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/home`                               | ✅ green                                                                      |
| `GET /api/cadences[?all=1]`                   | ✅ green                                                                      |
| `GET /api/cadences/:id`                       | ✅ green                                                                      |
| `POST /api/cadences/:id/stop`                 | ✅ green                                                                      |
| `GET /api/receipts[?play=&sinceDays=&limit=]` | ✅ green                                                                      |
| `GET /api/receipts/:id`                       | ✅ green                                                                      |
| `GET /api/plays`                              | ✅ green                                                                      |
| `GET /api/measure/cac[?sinceDays=]`           | ✅ green                                                                      |
| `GET /api/measure/rocs[?sinceDays=]`          | ✅ green                                                                      |
| `POST /api/measure/outcome`                   | ✅ green                                                                      |
| `GET /api/setup`                              | ✅ green                                                                      |
| `POST /api/setup`                             | ✅ green                                                                      |
| `GET /api/doctor`                             | ✅ green                                                                      |
| `POST /api/run/:playName` (SSE)               | ✅ green (returns valid SSE; full play execution requires real OneShot calls) |

## Distribution

| Path                                          | State                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `git clone && bun install && bun run cli`     | ✅ green                                                                                  |
| `bun link` global install                     | ✅ green                                                                                  |
| `bunx oneshot-gtm-server` (npm-published bin) | 🟡 build pipeline ready (`apps/server/dist/bin.mjs` + `dist/web/`); **not yet published** |

## Lint / typecheck / test

| Check                          | State                                                       |
| ------------------------------ | ----------------------------------------------------------- |
| `bun run typecheck`            | ✅ 0 errors across apps/cli + apps/server + packages/\*     |
| `bun run --cwd apps/web build` | ✅ 1849 modules transformed, ~298 kB main chunk gzip ~94 kB |
| `bun run lint`                 | ✅ 0 warnings, 0 errors (oxlint, 75 files)                  |
| `bun run fmt:check`            | ✅ all 140 files pass oxfmt                                 |
| `bun run test`                 | ✅ 24/24 vitest cases passing                               |
| `bun run cli -- doctor`        | ✅ all systems go                                           |

---

## Known limitations

- **`oneshot-gtm-server` requires Bun runtime** — `bun:sqlite` + `Bun.serve` + `Bun.stdin` are Bun-native. A runtime check in `dist/bin.mjs` fails loudly under plain `node` with an install hint. (Future option: ship a self-contained binary via `bun build --compile`.)
- **vhs terminal recording + UI gif not yet captured** — README references them but they need to be generated by the OneShot team during launch.
- **Telemetry endpoint not yet hosted** — the CLI respects the opt-out flag but there's no actual ingestion endpoint to send to. To be set up alongside the public benchmarks page (Phase 4).
- **Some plays untested against live OneShot** — see ⚠️ rows above. Marked because they require either a real phone number, real prospect inbox replies, or live OneShot Build/browser/web-search endpoints.

# Status

Snapshot of what's known to work end-to-end against the live OneShot API. Updated manually after each dogfood run; CI auto-update is on the Phase 3 roadmap.

Last manual update: **2026-06-03** · Bun **1.3.13** · OneShot SDK **0.16.2**

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

## `motion` (13 plays)

| Play                  | State       | OneShot calls                        | Cadence steps                                                                                                                                                                                                                |
| --------------------- | ----------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show-hn`             | ✅ green    | enrich + research + email            | one-touch (no follow-up)                                                                                                                                                                                                     |
| `job-change`          | ✅ green    | enrich + research + email            | day-5 follow-up + day-14 breakup                                                                                                                                                                                             |
| `post-funding`        | ✅ green    | enrich + research + email            | day-9 follow-up + day-18 breakup                                                                                                                                                                                             |
| `accelerator-batch`   | ✅ green    | enrich + (research?) + email         | day-5 single follow-up + breakup                                                                                                                                                                                             |
| `concierge`           | ⚠️ untested | voice + email                        | Requires real phone number for full test                                                                                                                                                                                     |
| `demo-no-show`        | ⚠️ untested | sms + email                          | Requires real phone number for SMS leg                                                                                                                                                                                       |
| `competitor-switch`   | ✅ green    | enrich + browser + email             | Migration-honesty pitch; drains the `find github-topics` queue; day-3 follow-up + day-8 breakup                                                                                                                              |
| `stack-consolidation` | ✅ green    | enrich + email                       | Consolidation-honesty pitch for repos wiring up several API vendors; drains `find github-topics`; day-3 follow-up + day-8 breakup; on `/run/stack-consolidation`                                                             |
| `repo-interest`       | ✅ green    | enrich + email                       | Complementary "you starred X → my product helps" intro; one-touch; drains the `find github-stars` queue (adjacent repos); on `/run/repo-interest`                                                                            |
| `luma-events`         | ✅ green    | enrich + email                       | Forward-looking "saw you're going to X next Tuesday" pitch to hosts + featured guests of upcoming Luma events; role-aware (an organizer is never pitched as a mere attendee); one-touch; drains the `find luma-events` queue |
| `hiring-signal`       | ⚠️ untested | enrich + websearch + webread + email | Web search against Lever/Greenhouse/Ashby; day-3 follow-up + day-8 breakup                                                                                                                                                   |
| `podcast-guest`       | ✅ green    | enrich + websearch + email           | Single touch, no follow-up                                                                                                                                                                                                   |
| `breakup-revive`      | ✅ green    | email only                           | Pulls from `listColdProspects`                                                                                                                                                                                               |

## `find` (upstream discovery → target_queue)

| Command                                         | State     | OneShot calls                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find show-hn`                                  | ✅ green  | findEmail + verifyEmail                                                                             | HN Algolia poller                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `find post-funding`                             | ✅ green  | webRead + findEmail + verifyEmail                                                                   | `--source-urls <file>` or `--auto` (webSearch by ICP + round)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `find accelerator-batch`                        | ✅ green  | findEmail + verifyEmail (+ webSearch fallback)                                                      | `cohort: yc-*` → free yc-oss/api directory; anything else → websearch adapter (Techstars / Antler / 500 / AI Grant). Rewrote out of the launch-index scrape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `find job-change`                               | ⚠️ opt-in | webSearch + findEmail + verifyEmail                                                                 | Disabled by default; `--personas` + `--companies` filters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `find hiring-signal`                            | ⚠️ opt-in | webSearch + webRead + findEmail + verifyEmail                                                       | Disabled by default; ATS search + corporate-domain lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `find podcast-guest`                            | ⚠️ opt-in | webSearch + webRead + findEmail + verifyEmail                                                       | Disabled by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `find breakup-revive`                           | ✅ green  | none (ledger-only)                                                                                  | Scans cold prospects; opt-in trigger (7d interval)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `find github-topics`                            | ✅ green  | gh-api manifest scan + findEmail + verifyEmail                                                      | Topic-driven GitHub finder — paste `topics` + `vendors` + `yourEdge` into /queue. Manifest-scan (`package.json`, `pyproject.toml`, `requirements.txt`) replaces the retired `agent-builders` Google-scrape. Feeds `competitor-switch` via shared `_repo-pipeline.ts`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `find github-stars`                             | ⚠️ opt-in | gh-api stargazers + findEmail + verifyEmail                                                         | Recent stargazers of watched repos. Per-repo `rel`: `competitor` → competitor-switch, `adjacent` → repo-interest. Needs `GITHUB_TOKEN`; readiness-gated on `repos` + `yourEdge`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `find luma-events`                              | ⚠️ opt-in | city-page discovery + event ICP gate + structured attendees + enrichProfile/findEmail + verifyEmail | Discovers upcoming events from Luma's per-city pages (free; webSearch fallback for unmapped cities); a keyword pre-filter + one event-level topic+ICP LLM call gate each event BEFORE any paid read; attendees (hosts + ~10 featured guests, with LinkedIn/website) come from Luma's public event JSON (`api.lu.ma/url`), falling back to webRead + LLM-extract; contact resolves via LinkedIn enrichProfile or website domain, then findEmail/verifyEmail. Rows are tagged Host/Guest. Readiness-gated on `topics` + `cities` + `yourEdge`. `LUMA_SESSION_COOKIE` is optional and only unlocks full guest lists for events YOU host (Luma gates others' guest lists). |
| `find queue / approve / reject / drain / watch` | ✅ green  | —                                                                                                   | Review lifecycle; `watch` has `--once` and daemon modes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

| Route                      | State                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (Home)                 | ✅ green — KPIs + signal feed + Scheduler strip (per-trigger last-run + next-due)                                                                                |
| `/queue`                   | ✅ green — target queue + triggers table (click-to-edit polling interval) + strategist dock + filters + per-row draft archive (subject/body/flags/receipt links) |
| `/inbox` (Replies)         | ✅ green — read-only OneShot inbox; replies matched to prospect + play + cadence status                                                                          |
| `/cadences`                | ✅ green (per-row preview + send + bulk + history + in-flight badge)                                                                                             |
| `/receipts`                | ✅ green (with signed-receipt modal)                                                                                                                             |
| `/plays`                   | ✅ green (with run + copy-CLI buttons)                                                                                                                           |
| `/measure`                 | ✅ green                                                                                                                                                         |
| `/setup`                   | ✅ green (editable wizard with hidden-input keys)                                                                                                                |
| `/run/show-hn`             | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| `/run/job-change`          | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| `/run/post-funding`        | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| `/run/accelerator-batch`   | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| `/run/hiring-signal`       | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| `/run/podcast-guest`       | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| `/run/competitor-switch`   | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| `/run/stack-consolidation` | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| `/run/repo-interest`       | ✅ green (SSE-streamed drafts)                                                                                                                                   |
| Strategist dock            | ✅ green — global floating launcher; renders SSE chat + action chips                                                                                             |

## Server (`apps/server`)

| Route                                         | State                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/home`                               | ✅ green                                                                                                                                                                                                                                                      |
| `GET /api/cadences[?all=1]`                   | ✅ green                                                                                                                                                                                                                                                      |
| `GET /api/cadences/:id`                       | ✅ green                                                                                                                                                                                                                                                      |
| `POST /api/cadences/:id/stop`                 | ✅ green                                                                                                                                                                                                                                                      |
| `POST /api/cadences/:id/preview-next`         | ✅ green — drafts next step, persists to ledger; 409 if no active cadence                                                                                                                                                                                     |
| `POST /api/cadences/:id/send-next`            | ✅ green — fire-and-forget; 202 + in-flight tracker; 409 if no persisted preview                                                                                                                                                                              |
| `POST /api/cadences/preview-batch`            | ✅ green — synchronous; parallelMap(3); per-row failure isolation                                                                                                                                                                                             |
| `POST /api/cadences/send-batch`               | ✅ green — fire-and-forget; 202 + per-row in-flight clears via callback                                                                                                                                                                                       |
| `GET /api/receipts[?play=&sinceDays=&limit=]` | ✅ green                                                                                                                                                                                                                                                      |
| `GET /api/receipts/:id`                       | ✅ green                                                                                                                                                                                                                                                      |
| `GET /api/plays`                              | ✅ green                                                                                                                                                                                                                                                      |
| `POST /api/plays/:name/cadence`               | ✅ green — edit a play's cadence step offsets                                                                                                                                                                                                                 |
| `GET /api/inbox`                              | ✅ green — read-only OneShot inbox, replies matched to prospects (SDK exposes list only)                                                                                                                                                                      |
| `POST /api/queue/:id/regenerate`              | ✅ green — re-draft a single queue row                                                                                                                                                                                                                        |
| `POST /api/queue/:id/send-draft`              | ✅ green — send the persisted draft for one queue row                                                                                                                                                                                                         |
| `GET /api/measure/cac[?sinceDays=]`           | ✅ green                                                                                                                                                                                                                                                      |
| `GET /api/measure/rocs[?sinceDays=]`          | ✅ green                                                                                                                                                                                                                                                      |
| `POST /api/measure/outcome`                   | ✅ green                                                                                                                                                                                                                                                      |
| `GET /api/setup`                              | ✅ green                                                                                                                                                                                                                                                      |
| `POST /api/setup`                             | ✅ green                                                                                                                                                                                                                                                      |
| `GET /api/doctor`                             | ✅ green                                                                                                                                                                                                                                                      |
| `POST /api/run/:playName` (SSE)               | ✅ green — dispatches show-hn, job-change, post-funding, accelerator-batch, hiring-signal, podcast-guest, competitor-switch, stack-consolidation, repo-interest. Accepts optional `dedupeKeys[]` to persist drafts back onto originating `target_queue` rows. |
| `GET /api/triggers`                           | ✅ green — includes `running`, `runningSince`, `ready`, `notReadyReason`                                                                                                                                                                                      |
| `POST /api/triggers/:name/enabled`            | ✅ green — 409 when readiness gate rejects                                                                                                                                                                                                                    |
| `POST /api/triggers/:name/config`             | ✅ green                                                                                                                                                                                                                                                      |
| `POST /api/triggers/:name/run`                | ✅ green — fire-and-forget; 202 + `pending:true`, 409 on duplicate or not-ready                                                                                                                                                                               |
| `POST /api/strategist/stream` (SSE)           | ✅ green — chat endpoint backed by ICP + per-trigger briefs; emits `<!--ACTION:...-->` markers                                                                                                                                                                |

## Distribution

| Path                                          | State                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `git clone && bun install && bun run cli`     | ✅ green                                                                                  |
| `bun link` global install                     | ✅ green                                                                                  |
| `bunx oneshot-gtm-server` (npm-published bin) | 🟡 build pipeline ready (`apps/server/dist/bin.mjs` + `dist/web/`); **not yet published** |

## Lint / typecheck / test

| Check                          | State                                                        |
| ------------------------------ | ------------------------------------------------------------ |
| `bun run typecheck`            | ✅ 0 errors across apps/cli + apps/server + packages/\*      |
| `bun run --cwd apps/web build` | ✅ ~1850 modules transformed, ~300 kB main chunk gzip ~94 kB |
| `bun run lint`                 | ✅ 0 warnings, 0 errors (oxlint, 202 files)                  |
| `bun run fmt:check`            | ✅ all files pass oxfmt                                      |
| `bun run test`                 | ✅ 701/701 vitest cases passing (59 test files)              |
| `bun run cli -- doctor`        | ✅ all systems go                                            |

---

## Known limitations

- **`oneshot-gtm-server` requires Bun runtime** — `bun:sqlite` + `Bun.serve` + `Bun.stdin` are Bun-native. A runtime check in `dist/bin.mjs` fails loudly under plain `node` with an install hint. (Future option: ship a self-contained binary via `bun build --compile`.)
- **vhs terminal recording + UI gif not yet captured** — README references them but they need to be generated by the OneShot team during launch.
- **Telemetry endpoint not yet hosted** — the CLI respects the opt-out flag but there's no actual ingestion endpoint to send to. To be set up alongside the public benchmarks page (Phase 4).
- **Some plays untested against live OneShot** — see ⚠️ rows above. Marked because they require either a real phone number, real prospect inbox replies, or live OneShot Build/browser/web-search endpoints.

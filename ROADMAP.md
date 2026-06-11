# Roadmap

Public. Issues mirror the items below. PRs welcome.

## Phase 0 — Tweetable demo (shipped)

- [x] Repo scaffolding (Bun monorepo, MIT)
- [x] `init`, `config llm`, `config founder`, `config telemetry`
- [x] `doctor` (wallet, LLM key, ledger, founder profile)
- [x] `intel advise` — interactive coach grounded in last 7 days of receipts
- [x] `discover icp interview-prep` — Mom Test guide generator
- [x] `discover icp synthesize` — JTBD / pain / switch / ICP language extraction
- [x] `motion show-hn` — founder-to-founder one-touch with anti-slop linting
- [x] `measure receipt` — fetch + display a signed receipt
- [ ] vhs terminal recording embedded in README
- [ ] Launch posts (HN, Bookface, IH, X, Reddit) — drafts in `launch/`

## Phase 1 — First real GTM loop (shipped)

- [x] `motion job-change` — UserGems-style trigger play (now multi-touch via cadence engine)
- [x] `motion post-funding` — funding-trigger sequence (day 3+ timing, multi-touch via cadence)
- [x] `motion accelerator-batch --sender-cohort <yc-w26|od|spc|antler|...>` — parameterized cohort outreach
- [x] `intel triage-replies` — LLM categorizes inbound, drafts founder-approved replies
- [x] `intel weekly-review` — Monday narrative brief
- [x] `intel personalize` exposed as a standalone command
- [x] `measure cac` — per-play CAC, $/send, $/reply from signed receipts
- [x] Anti-AI-slop linter expanded with the Wikipedia "Signs of AI writing" canon
- [x] `discover pmf classify` — Sequoia Arc + Balfour Four-Fits classifier
- [x] `discover pmf survey` — Superhuman 5-question survey via OneShot Build (landing) + Email + inbound poll + Sean Ellis analyzer
- [x] `discover pmf survey-collect` — analyzer that turns inbound replies into a paste-able PMF report
- [x] `handoff readiness` — six-signal PMF→scale scorecard with green/yellow/red verdict
- [x] `handoff templatize` — soft-gated template extraction from top-converting hand-written sends
- [x] `handoff first-ae` — Lemkin / Blond / Kazanjy five-gate hire-readiness check
- [x] **Cadence engine v1** — inbound-driven multi-touch sequencer (`cadence advance / list / stop`); polls OneShot inbox, marks replies, fires due follow-ups, ends with a breakup touch

## Phase R0 — Tooling baseline + monorepo restructure (shipped)

- [x] Turborepo + `turbo.json`
- [x] Vitest 4 with first 24 tests (ledger schema + lint regex coverage)
- [x] oxlint + oxfmt (Rust-based; ~50× faster than ESLint/Prettier)
- [x] `tsconfig.base.json` shared across all apps + packages
- [x] Bun catalog for shared dep versions
- [x] Move `packages/cli` → `apps/cli`; root workspaces switched to `["apps/*", "packages/*"]`
- [x] All previous CLI behavior preserved

## Phase R1 — Read-only web dashboard (shipped)

- [x] `packages/shared-types` — wire types for the API contract
- [x] `apps/server` — Bun.serve with read-only `/api/*` (home, cadences, receipts, plays, measure, doctor, setup)
- [x] `apps/web` — Vite + React 19 + Tailwind 4 + TanStack Router + TanStack Query + Base UI + cva
- [x] Pages: Home / Cadences / Receipts (with signed-receipt modal) / Plays (with copy-CLI button) / Measure (CAC + RoCS tables) / Setup (read-only profile + secrets sources)
- [x] `oneshot-gtm ui` boots the server, opens the browser, supports `--dev` for hot-reload (vite + server in parallel)

## Phase R2 — UI mutations (shipped)

- [x] `/setup` editable wizard: founder profile + LLM provider/model + secrets (hidden inputs) + wallet mode → POSTs to `/api/setup`, writes to chmod-600 `~/.oneshot-gtm/.env`. Doctor + key sources update live after save.
- [x] `apps/server/src/api/run.ts` — `POST /api/run/$playName` SSE endpoint for `show-hn`, `job-change`, `accelerator-batch`. Streams `draft` → `send` → `done` events.
- [x] `/run/$playName` web form: editable target rows (add/remove), dry-run toggle, send button. Consumes the SSE stream, renders drafts inline with lint flags + clickable receipt links.
- [x] `/cadences` rows now have inline "stop" + "log outcome" actions; outcome modal supports `meeting_booked / sql_qualified / deal_won / deal_lost / ghosted` + amount + notes.
- [x] `/plays` cards now have a "run" button next to "copy CLI" for the three R2-supported plays.
- [x] New UI primitives: `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Modal`.

## Phase R3 — Polish + distribute (shipped)

- [x] **README rewrite** with "Two ways to use it" framing (CLI for power, dashboard for visibility), badges row, full command map, comparison table, architecture diagram, stack section, distribution paths.
- [x] **`apps/server` tsdown bundle** — `bun run --cwd apps/server build` produces `dist/bin.mjs` (~57 kB, gzip 14.7 kB) + `dist/web/` (web build is auto-copied). Bundles workspace packages, externalizes `bun:sqlite` + SDK + open. Runtime check fails loudly with install hint if invoked under plain node.
- [x] **`oneshot-gtm-server` package shape** — `bin: { "oneshot-gtm-server": "./dist/bin.mjs" }`, `prepublishOnly` builds web + server. Ready for `npm publish` (final push is OneShot team's hand on the trigger).
- [x] **STATUS.md** — manual snapshot of what's known to work end-to-end against the live OneShot API.
- [x] **Built-with-oneshot-gtm badge** — embedded in README + dedicated `docs/badge.md` with markdown / HTML / variants.
- [x] **Launch posts updated** — Show HN + Twitter/X drafts now mention the dashboard and the two-surface story.
- [ ] vhs terminal recording (60s) — needs OneShot team
- [ ] Dashboard demo gif (30s) — needs OneShot team
- [x] **`oneshot-gtm-server@0.1.0` shipped on npmjs.com** via tag-driven workflow (`.github/workflows/release.yml`). `bun run release:server` cuts a release; provenance attestation attached. CLI (`oneshot-gtm`) still needs its own `tsdown` setup before it can ship — deferred to a follow-up.

## Phase 2 — Multichannel + warm-signal escalation (shipped)

- [x] **Cadence engine v2** — SMS + voice channels are now first-class step types; per-play sequences can mix email, SMS, voice
- [x] `motion concierge` — autonomous voice onboarding (pre-call email + voice w/ structured data + post-call summary email)
- [x] `motion demo-no-show` — same-day SMS + email recovery; cadence engine handles day-3 follow-up
- [x] `motion competitor-switch` — migration-honesty pitch with optional G2/BuiltWith scrape via OneShot browser automation
- [x] `motion hiring-signal` — job-posts trigger using OneShot web search + web read for specific job-post phrasing
- [x] `motion podcast-guest` — single touch referencing a specific quote
- [x] `motion breakup-revive` — pattern-interrupt for ledger cold leads (60-90 days)
- [x] `measure rocs` — Return on Cognitive Spend: per-play $/meeting, $/SQL, $/won
- [x] `measure outcome` — log deal outcomes (meeting_booked / sql_qualified / deal_won / deal_lost / ghosted)
- [ ] `measure benchmark` — opt-in cohort comparisons (deferred to Phase 3 since it needs a hosted endpoint)
- [ ] Warm-signal escalation in cadence (open-tracking → auto phone call) — needs OneShot to surface open events

## Phase F1 — Find layer (shipped)

The motion plays needed hand-curated JSON target lists; founders kept asking "where do these targets come from?" F1 closes that loop with an upstream discovery layer.

- [x] **`target_queue` + `triggers` ledger tables** (schema v4) with cross-table dedupe against `prospects.email`
- [x] `find show-hn` — HN Algolia poller, ICP-filter → enrich (findEmail + verifyEmail) → enqueue
- [x] `find post-funding --source-urls <file>` — read TC/Crunchbase/blog URLs, LLM-extract structured facts, enrich, enqueue
- [x] `find accelerator-batch --cohort yc-w26` — pull YC launch index, LLM-extract company list, per-company webRead → enrich → enqueue
- [x] `find queue / approve / reject / drain / watch` — review lifecycle in CLI
- [x] `find watch` — long-running poller with `--once` for cron + foreground daemon mode; per-trigger interval + spend cap
- [x] **Web `/queue` page** — filterable inbox (status + play), bulk approve, drain modal per play with dry-run toggle
- [x] `config icp set/show` + free-text ICP one-liner used by the binary classifier prompt
- [x] `findEmail` + `verifyEmail` wrappers in `packages/core/src/oneshot.ts`
- [x] Server `/api/queue/*` routes; SDK clients via `apps/web/src/api/client.ts`

## Phase F2 — Sourcing breadth + trigger UI (shipped)

- [x] `find post-funding --auto` — webSearch by ICP-derived industry × round; bypasses the URL file. Registered as the `post-funding-auto` trigger (12h interval).
- [x] `find job-change` — webSearch for "joined as <persona>" announcements with `--personas` + `--companies` filters
- [x] `find hiring-signal` — Greenhouse / Lever / Workable / Ashby ATS search with smart corporate-domain lookup (webSearch fallback when LLM doesn't extract one)
- [x] `find podcast-guest` — recent-guest discovery across Latent Space / Lenny's / 20VC / Acquired / Invest Like the Best
- [x] `find accelerator-batch` — `--index-url` override + cohort aliases for OD, SPC, Antler, Techstars
- [x] **Trigger-config UI** in `/queue`: enable/disable toggle, last-poll + last-run summary, JSON config editor with `intervalMs` override (min 60s)
- [x] Opt-in triggers — `job-change`, `hiring-signal`, `podcast-guest` register disabled-by-default; founder enables from the UI without touching code
- [x] `drainQueue` dispatcher handles all six finders (was missing hiring-signal + podcast-guest)
- [x] Partial-send id-mapping fix — drain no longer marks the wrong rows as sent when some drafts fail mid-batch
- [x] Three new structured-output prompts: `job-change-extract`, `hiring-signal-extract`, `podcast-guest-extract`

## Phase F3 — Real-time signals + ICP learning loop

- [ ] **Webhook intake** — `POST /api/triggers/cal-no-show` + `POST /api/triggers/signup` → ICP-filter → enqueue into `demo-no-show` / `concierge`. Turns oneshot-gtm from polling into real-time.
- [ ] **ICP-filter learning loop v1** — every `icpFilter` call pulls the last ~20 (candidate, decision, reason) tuples from `target_queue` as in-context examples. Tighter filtering, zero schema change.
- [x] `find github-topics` (retiring `agent-builders`) — GitHub signal source via the public Search API + manifest-scan (`package.json`, `pyproject.toml`, `requirements.txt`, `.env.example`) for deterministic vendor-stack detection. Config-driven: founder supplies `topics` + `vendors` + `yourEdge` via `/queue`. Feeds `competitor-switch` via the shared `_repo-pipeline.ts`. Idempotent boot migration ports a prior `agent-builders` config to the new trigger; the old trigger + its queue rows are retired.
- [x] `find breakup-revive` — scan the local ledger for cold prospects (60–90d window) and enqueue them (opt-in trigger, 7d interval, zero OneShot spend)
- [x] **Trigger strategist** — `POST /api/strategist/stream` SSE chat endpoint backed by the founder's ICP + per-trigger briefs. Proposes config in plain English, emits `<!--ACTION:...-->` markers the UI renders as confirmation chips, and applies through the existing `enable` / `apply-config` REST routes. Mounted as a global floating dock (`StrategistDock`) on every page.
- [x] **Trigger fire-and-forget** — `POST /api/triggers/:name/run` returns 202 + `pending: true` immediately; finder runs on the event loop. `TriggerView.running` + `runningSince` give the UI a server-authoritative spinner. 409 on duplicate click prevents double-spend.
- [x] **Readiness gate** — `TriggerSpec.readiness` rejects enabling/firing a trigger whose stored config lacks required inputs (e.g. `github-topics` without `topics`/`vendors`/`yourEdge`, or `accelerator-batch` without a `cohort`). Shown inline in the `/queue` row + as a 409 reason on the run endpoint.
- [x] **Stale-run sweep on cold boot** — `ledger.sweepStaleRunningTriggers()` clears trigger rows left in `running` state by a previous process that died without updating `last_polled_at` (bun --watch re-exec, OOM, OS reboot). Writes a `killed_by_restart` summary so `/queue` shows the actual state instead of a stale one. `MAX_RUN_AGE_MS` bumped 15min → 4h to match real finder runtimes (50 candidates × ~70s serial). `markTriggerRunning` also reclaims stale rows so a stuck flag can't permanently 409 the founder.
- [x] **`accelerator-batch` finder rewrite** — yc-oss/api directory (free, daily-updated) for any YC batch; websearch fallback adapter for non-YC cohorts (Techstars, Antler, 500 Global, AI Grant). Trigger renamed `yc-w26` → `accelerator-batch` via idempotent boot migration.
- [x] **Drain → /run handoff** — `/queue` drain modal navigates to `/run/<play>?fromQueue=1` with the modal's collected fields (limit, dryRun, senderCohort, offer) round-tripping via search params. Single code path now surfaces every draft + lint flag for both dryRun and real-send branches.
- [x] **Drafts persist per `target_queue` row** — schema v6 (`last_draft_json` + `last_drafted_at` columns added via `addColumnIfMissing`). The `/api/run` SSE endpoint writes each generated draft back to its originating row when called with `dedupeKeys[]`. `/queue` expanded rows render the draft block (subject + body + flags + receipt links); collapsed rows get a `draft` badge.
- [x] **`/home` Scheduler section** — per-trigger row showing state pill, last-run summary, last-polled, next-due (oxblood when overdue). Disabled triggers collapse behind a chevron. Read-only, polls `api.triggers()` every 30s; answers "is the scheduler alive?" at a glance.
- [x] **`findEmail` prescreen** — dud-domain blocklist (free-tier subdomains, social/content hosts, personal email, link aggregators, investor aggregators) + handle-not-name guard (single-token usernames like HN authors) before every SDK call. Cuts ~50% of historically-unfound lookups, ~$1–2/run. Skipped rows log `finder.skipped_findemail` events for blocklist tuning.
- [x] **`stack-consolidation` play** — consolidation-honesty pitch for repos wiring several API vendors; drains the `github-topics` queue alongside `competitor-switch`; day-3 follow-up + day-8 breakup; on `/run/stack-consolidation`
- [x] **`/inbox` ("Replies") page** — read-only OneShot inbox via `GET /api/inbox`; each reply matched to its prospect + play + cadence status by sender address (SDK exposes list only, so no reply/mark-read)
- [x] **Per-play cadence editor** — `POST /api/plays/:name/cadence` edits step day-offsets from the `/plays` page; `competitor-switch` + `hiring-signal` gained day-3 follow-up + day-8 breakup
- [x] **Per-row queue actions** — `POST /api/queue/:id/regenerate` re-drafts and `:id/send-draft` ships a single persisted draft
- [ ] **`find watch` as an OS service** — launchd plist + systemd unit + Windows Service docs; `--once` mode already works for cron

## Phase F4 — Operationalize + scale

- [ ] **Bulk Clay / Apollo CSV import** — `find import --csv <file> --play <name>` with column mapping; drop-in for cohorts you already paid to source
- [ ] **ICP-filter learning loop v2** — periodic LLM job that proposes a tighter ICP one-liner from accumulated decisions; founder approves the rewrite in `/queue`
- [ ] **Per-source weighting** in the watch loop — track approval rate per finder; deprioritize noisy sources automatically
- [x] **Per-trigger interval UI** — the interval cell in the /queue triggers table is click-to-edit: preset select (1h–7d) + a revert-to-default option, writing the same `intervalMs` config override the JSON editor uses; scheduler picks the new cadence up on its next tick
- [ ] **Webhook signing + replay protection** for the F3 endpoints

## Phase 3 — Distribution flywheel

- [ ] Public benchmarks page powered by opt-in telemetry
- [ ] CRM adapters: Attio, Folk, Pipedrive
- [ ] Slack / Linear notification webhooks
- [ ] Fireship sponsor video
- [ ] "Built with oneshot-gtm" badge program (the artifact shipped in R3; this is the adoption push)
- [ ] BYO sending domain (advanced — OneShot handles the default)
- [ ] Multi-user / hosted dashboard ("OneShot Cloud" territory)

## Things we intentionally do NOT do

- Run an SDR. The CLI helps you do founder-led sales. It will refuse to advise a `first-ae` hire pre-PMF.
- Manage SPF/DKIM/DMARC. OneShot auto-provisions sending domains.
- Hold your customer data. Local SQLite ledger only.
- Lock you into our LLM. BYO key, swap providers freely.

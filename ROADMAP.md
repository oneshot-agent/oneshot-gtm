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
- [ ] `npm publish apps/server` — needs OneShot team

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

## Phase 3 — Distribution flywheel

- [ ] Public benchmarks page powered by opt-in telemetry
- [ ] CRM adapters: Attio, Folk, Pipedrive
- [ ] Slack / Linear notification webhooks
- [ ] Fireship sponsor video
- [ ] "Built with oneshot-gtm" badge program
- [ ] BYO sending domain (advanced — OneShot handles the default)

## Things we intentionally do NOT do

- Run an SDR. The CLI helps you do founder-led sales. It will refuse to advise a `first-ae` hire pre-PMF.
- Manage SPF/DKIM/DMARC. OneShot auto-provisions sending domains.
- Hold your customer data. Local SQLite ledger only.
- Lock you into our LLM. BYO key, swap providers freely.

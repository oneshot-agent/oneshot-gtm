# oneshot-gtm

> Open-source GTM agent for technical founders. Pay-per-result. Signed receipts. Founder-led discipline encoded. Two surfaces: terminal CLI + local web dashboard, both backed by the same SQLite ledger.

```bash
# Dashboard-only (published, no clone needed):
bunx oneshot-gtm-server     # opens http://127.0.0.1:3030

# Full install (CLI + dashboard, repo clone — see below):
bun run cli -- init         # one-time setup
bun run cli -- ui           # opens http://127.0.0.1:3030
```

[![Built with oneshot-gtm](https://img.shields.io/badge/built%20with-oneshot--gtm-0a0a0a?style=flat&labelColor=18181b&color=22c55e)](https://github.com/oneshot-agent/oneshot-gtm) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![Bun](https://img.shields.io/badge/runtime-Bun%201.3+-fbf0df?logo=bun&logoColor=black)](https://bun.sh) [![TypeScript](https://img.shields.io/badge/typed-TypeScript%206-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

---

## What this is

A focused, opinionated wrapper around [OneShot](https://docs.oneshotagent.com) — a pay-per-use API toolbox for email, SMS, voice, deep research, person enrichment, browser automation, and website build, all settled per-call in USDC on Base with **cryptographically signed receipts** for every action.

OneShot is the toolbox. `oneshot-gtm` is the **strategy wrapper**: it encodes the canonical PMF + founder-led-sales playbook (Mom Test, Sean Ellis 40%, Predictable Revenue, do-things-that-don't-scale, multichannel cadence, signed-receipt CAC) as a set of named _plays_ you actually run from the terminal or the dashboard.

It's open source (MIT) so you can read every prompt, fork every play, and trust what's running.

---

## Two ways to use it

### Terminal — for power users + scripting

```bash
bun run cli -- intel advise                                  # interactive coach
bun run cli -- discover icp interview-prep "your hypothesis"
bun run cli -- find watch --once                             # poll all due triggers, enqueue candidates
bun run cli -- find drain podcast-guest --dry-run            # preview approved /queue rows
bun run cli -- cadence advance                               # daily tick: poll inbox + fire follow-ups
```

~30 commands across 9 groups. See `bun run cli -- --help` or jump to the [Command map](#command-map).

### Dashboard — for visibility + non-technical co-founders

```bash
bun run cli -- ui                # default: serves prebuilt React app on 127.0.0.1:3030
bun run cli -- ui --dev          # vite hot-reload + API server in parallel
bun run cli -- ui --port 4000    # custom port
bun run cli -- ui --no-browser   # don't auto-open
```

Eight pages, all reading the same `~/.oneshot-gtm/ledger.sqlite`:

- **Home** — spend (7d / 30d), reply rate trend, in-flight cadences, recent receipts
- **Queue** — triggers table (enable, edit JSON config, fire) + target queue (status + play filters, bulk approve). Per-play **Drain** opens a modal that hands off to `/run/<play>` with approved rows pre-loaded — every draft + lint flag streams live, and the latest draft persists on the queue row so you can re-read it later by expanding the row (subject + body + flags + receipt links). Per-row spinner + locked button while a trigger is running.
- **Replies** (`/inbox`) — read-only view of the OneShot inbox; each reply matched to its prospect + play + cadence status by sender address
- **Cadences** — table view with inline **Stop** + **Log outcome** buttons; outcome modal supports `meeting_booked / sql_qualified / deal_won / deal_lost / ghosted`. Per-row chevron exposes the next-step draft preview before send; bulk select for batch preview/send; sent-step history collapsible inline; pulsing "sending" badge while a fire-and-forget send is in flight.
- **Receipts** — paginated table; click a row → modal with the signed receipt payload
- **Plays** — cards with channel badges + **Run** button (for `show-hn` / `job-change` / `post-funding` / `accelerator-batch` / `hiring-signal` / `podcast-guest` / `stack-consolidation` / `repo-interest`) + **Copy CLI** button
- **Measure** — CAC + RoCS tables filterable by time range
- **Setup** — editable wizard: founder profile, LLM provider/model, OneShot wallet keys (hidden inputs), telemetry toggle. Saves to chmod-600 `~/.oneshot-gtm/.env`.

The `Run a play` form (`/run/$playName`) takes editable target rows + a dry-run toggle and streams drafted emails back via Server-Sent Events with lint flags + clickable receipt links. When arriving from `/queue` via the Drain button, target rows auto-hydrate from approved queue rows and each generated draft persists back to its originating row on completion — re-readable from `/queue` at any time.

A floating **strategist dock** is mounted on every page. Open it to chat through trigger config: it reads your ICP + product one-liner and proposes JSON configs as confirmation chips you click to apply. Endpoint: `POST /api/strategist/stream` (SSE).

### Discovery — where targets come from

Motion plays don't require hand-curated JSON anymore. Ten **finders** auto-discover prospects, ICP-filter them, and enqueue into `/queue` for one-click approve / reject:

- **`show-hn`** — HN Algolia poller, surfaces same-day Show HN posts
- **`post-funding`** — webSearch by ICP-derived industry × round (auto), or a TC/Crunchbase URL list
- **`job-change`** — webSearch for `"joined as <persona>"` announcements with persona + company filters
- **`hiring-signal`** — Greenhouse / Lever / Workable / Ashby ATS search
- **`podcast-guest`** — recent-guest discovery across Latent Space, Lenny's, 20VC, Acquired, Invest Like the Best
- **`accelerator-batch`** — yc-oss directory + websearch fallback for non-YC cohorts (Techstars, Antler, 500 Global, AI Grant)
- **`github-topics`** — GitHub-API manifest scan (`package.json`, `pyproject.toml`, `requirements.txt`) detects vendor stack deterministically; finds repos stitching together N agent vendors as competitor-switch targets
- **`github-stars`** — recent stargazers of repos you watch, routed per repo: tag a repo `competitor` (→ competitor-switch) or `adjacent` (→ repo-interest, a "you're into X, my product helps" intro)
- **`luma-events`** — upcoming events from Luma's own city pages (genuinely upcoming, not search-indexed leftovers), gated per event by a topic + ICP check before any spend; pitches the hosts + featured guests Luma exposes publicly per event — with their LinkedIn/website, so contact resolution actually lands. Each queue row is tagged `Host` or `Guest` and drafted accordingly
- **`breakup-revive`** — scans the local ledger for prospects cold for 60-90 days

Each finder runs as a **trigger** with its own interval + spend cap — click the interval in the `/queue` triggers table to change cadence (presets 1h–7d, or revert to the default). Captured per-prospect signals (LinkedIn URL via webSearch + phone via passive enrichment when surfaced) show next to the email + company in `/queue`. Approved rows ship via `bun run cli -- find drain <play>` or the per-play **Drain** button on the Queue page.

The dashboard server runs an in-process scheduler that fires enabled triggers on their interval automatically — open `bun run cli -- ui`, enable a trigger, and it polls without you needing a separate `find watch` daemon. The CLI watch command stays useful for cron + headless deployments where you don't want the dashboard.

`/home` surfaces a **Scheduler** section per trigger — state pill, last-run summary (the `cand=N · kept=M · icp=K · $X.YY` line you see on `/queue`), last polled, next due — so "is the scheduler alive?" is a glance, not a `grep events.jsonl`. Overdue triggers show in oxblood; disabled ones collapse behind a chevron.

A trigger whose stored config is missing required inputs (e.g. `accelerator-batch` without a `cohort`) reads as **not ready** on `/queue` — the Enable toggle and Run Now button are disabled with the reason in a tooltip. Edit config via the pencil icon to clear it; nothing fires while a trigger is unready. The same gate returns `409` on `POST /api/triggers/:name/enabled` and `:name/run`, so scripted callers can't bypass it.

Before any `findEmail` call, a pre-flight check skips dud domains (free-tier subdomains like `*.vercel.app`/`*.github.io`, social hosts, link aggregators, personal email providers) and inputs where the "name" is obviously a username (`samaralihussain`, no whitespace or period). On a 50-candidate Show HN run that historically dropped ~37 of 50 at the SDK, the prescreen now eliminates the wasted spend at ~$0.05/call — roughly $1–2 saved per run. Skipped rows log a `finder.skipped_findemail` event with the reason for later blocklist tuning.

## Sender rotation — OneShot domains or your own Gmail

Outbound ships through a **sender identity pool**: any mix of OneShot wallet-owned domains and your own Gmail / Google Workspace accounts. Routing rules:

- **Sticky threads** — every email to a given prospect comes from the identity that sent their first touch, across plays and cadence steps. In-flight conversations never switch From address.
- **Warm-up caps** — a freshly added Gmail account ramps automatically (10/day, +10/week, max 50 by default; edit per identity on `/setup`). OneShot identities are uncapped and absorb overflow.
- **Defer, don't exceed** — when every identity hits its daily cap, cadence steps stay due and queue rows stay approved until capacity resets at midnight. Nothing sends over cap.
- **Replies follow the pool** — the inbox poll merges the OneShot inbox with every authorized Gmail account, so stop-on-reply works no matter which identity sent.

Add a Gmail account with `bun run cli -- gmail auth` (one-time browser OAuth consent; needs a Google Cloud OAuth client of type *Desktop* with the Gmail API enabled — `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` are shared across accounts, per-account refresh tokens live chmod-600 in `~/.oneshot-gtm/gmail-tokens.json`). `oneshot-gtm doctor` reports each identity's auth status and today's usage. With no pool configured, behavior is exactly the classic single OneShot identity.

---

## 60-second setup

```bash
# 1. Install Bun (https://bun.sh) — required runtime
curl -fsSL https://bun.sh/install | bash

# 2. Clone + install
git clone https://github.com/oneshot-agent/oneshot-gtm
cd oneshot-gtm
bun install

# 3. Set up config + keys (interactive wizard)
bun run cli -- init

# 4. Sanity check
bun run cli -- doctor

# 5. Try the coach (no OneShot calls — uses your LLM key only)
bun run cli -- intel advise

# 6. Open the dashboard
bun run --cwd apps/web build       # one-time: build the static SPA
bun run cli -- ui                  # opens http://127.0.0.1:3030
```

**Make `oneshot-gtm` available globally** (optional, one-time):

```bash
cd apps/cli && bun link && bun link oneshot-gtm && cd -
oneshot-gtm doctor                 # now works from anywhere
```

---

## Why this exists

Most GTM tools (Apollo, Clay, Outreach, Lemlist, Smartlead) assume you have product-market fit and just optimize sends. Most pre-PMF founders don't. They end up scaling broken motions because the tool says "send more" — which the [Startup Genome Report](https://startupgenome.com) cites as the #1 documented cause of startup death.

`oneshot-gtm` encodes the discipline:

- Plays default to **founder-to-founder voice**, low volume (≤50/day), one-touch unless the cadence engine is invoked.
- Every drafted email passes a **lint pass** based on the Wikipedia "Signs of AI writing" canon — banned phrases, em dashes, AI vocabulary, copula avoidance, three-item lists, sycophantic openers, generic positive endings.
- Scale-move commands (`handoff templatize`, `handoff first-ae`, `handoff readiness`) print **soft-gate checklists** — they default to "not yet, fix this first" if the underlying signals haven't earned the move, but the founder can always say `--force` to proceed.
- Every paid action emits a **signed receipt**; the dashboard's **Measure** page renders per-play CAC + RoCS unit economics that are cryptographically attestable, not estimated.

---

## Command map

```
oneshot-gtm
├── init                                     first-run setup wizard (profile + keys)
├── config
│   ├── llm                                  pick OpenRouter / OpenAI / Anthropic + model
│   ├── founder                              name, reply-to email, product one-liner
│   ├── keys                                 update API keys (chmod 600 ~/.oneshot-gtm/.env)
│   └── telemetry on|off
├── doctor                                   wallet, ledger, keys, founder profile
├── ui                                       open the local dashboard
│
├── discover
│   ├── icp interview-prep [hypothesis]      Mom Test + JTBD + Switch script
│   ├── icp synthesize <transcript-dir>      JTBD, pain, switch moment, ICP language
│   └── pmf
│       ├── classify                         Sequoia Arc + Balfour Four Fits
│       ├── survey --cohort <file>           Build landing page + email + collect inbound
│       └── survey-collect                   Analyze inbound replies → Sean Ellis report
│
├── find                                     scheduled discovery — ad-hoc runs live in the dashboard
│   ├── watch [--once] [--quiet]             daemon: poll registered triggers + enqueue candidates
│   └── drain <play> [--limit N] [--dry-run] ship approved /queue rows through the matching motion play
│
├── motion                                   CLI-only plays (rest live in /run)
│   ├── post-funding --target <file>         prospect's company just raised (send day 3+)
│   ├── concierge --target <file>            autonomous voice onboarding
│   ├── demo-no-show --target <file>         same-day SMS + email recovery
│   ├── competitor-switch --target <file>    migration pitch w/ G2/BuiltWith scrape via browser
│   ├── hiring-signal --target <file>        trigger off prospect's open job post
│   ├── podcast-guest --target <file>        reference a specific quote from a recent podcast
│   └── breakup-revive                       pattern-interrupt for cold ledger leads
│
│   show-hn / job-change / accelerator-batch / stack-consolidation / repo-interest live in the dashboard /run page
│
├── cadence
│   └── advance [--dry-run]                  poll inbound + fire due follow-ups
│
├── intel
│   ├── advise                               interactive coach with conversation memory
│   ├── personalize --prospect-name ...      one anti-slop opener for any prospect
│   ├── triage-replies                       classify inbound + draft founder-approved replies
│   └── weekly-review                        paste-able Monday narrative brief
│
└── handoff
    ├── readiness                            six-signal PMF→scale scorecard
    ├── templatize --input <file>            soft-gated template extraction
    └── first-ae                             five-gate hire-readiness check (Lemkin/Blond/Kazanjy)
```

> **Where's `measure`?** Spend, CAC, RoCS, deal-outcome logging all live in the dashboard's **Measure** + **Cadences** pages — single source of truth, no `--since-days` flag dance. The `/api/measure/*` routes are still there if you'd rather hit them directly.

---

## Comparison

|                   | Apollo / Clay / Outreach / Smartlead  | oneshot-gtm                                     |
| ----------------- | ------------------------------------- | ----------------------------------------------- |
| Pricing           | Seat-based SaaS, $$/seat/mo           | Pay-per-result via OneShot, no subscription     |
| Source visibility | Closed; you trust the dashboard       | MIT; read the prompts, fork the plays           |
| CAC story         | Blended, estimated, dashboard-shaped  | Signed per-call receipts, exportable as proof   |
| PMF posture       | Assumes PMF, optimizes sends          | Pre-PMF aware, soft-gates on scale moves        |
| First-run         | Demo call → seat license → onboarding | `bunx oneshot-gtm init` → first artifact in 60s |
| LLM               | Built-in, opaque                      | BYO key (OpenRouter / OpenAI / Anthropic)       |
| State             | Vendor cloud                          | Local SQLite + chmod-600 dotfile                |
| Surfaces          | Web app only                          | Terminal CLI + local web dashboard              |

---

## Architecture

```
                   ┌─────────────────────────────────────────────┐
                   │  apps/cli   apps/server   apps/web          │   ← surfaces
                   │  commander Bun.serve+SSE  Vite+React+TanStack│
                   └──────────────────┬──────────────────────────┘
                                      │
                   ┌──────────────────┴──────────────────────────┐
                   │  packages/* (the brains, shared by all 3)   │
                   │  core, intel, plays, find, prompts,         │
                   │  doctor, shared-types                       │
                   └──────────────────┬──────────────────────────┘
                                      │
                                      ▼
                   ┌─────────────────────────────────────────────┐
                   │  @oneshot-agent/sdk (OneShot's primitives)  │
                   │  email, SMS, voice, research, enrichment,   │
                   │  browser, build, signed receipts            │
                   └─────────────────────────────────────────────┘
```

**State**: a single `~/.oneshot-gtm/ledger.sqlite` is the source of truth. CLI, server, and web all read/write the same tables (`receipts`, `prospects`, `sequence_events`, `cadence_state`, `deal_outcomes`, `interviews`, `target_queue`, `triggers`).

**Secrets**: `~/.oneshot-gtm/.env` chmod-600. Auto-loaded into `process.env` on first import.

**Server**: single-user, local-first, binds to `127.0.0.1` only. No auth. Multi-user is a separate future product (see [out of scope](#out-of-scope) below).

---

## Stack

Bun-native, all the modern picks:

- **Runtime**: [Bun](https://bun.sh) 1.3+
- **Monorepo**: [Turborepo](https://turbo.build) + Bun catalog for shared dep versions
- **Test**: [Vitest 4](https://vitest.dev) (701 cases across 59 files; ledger, lint, finder pipelines, play registry, strategist endpoint, web bucketing helpers)
- **Lint / format**: [oxlint](https://oxc.rs) + [oxfmt](https://oxc.rs) (Rust-based, ~50× faster than ESLint/Prettier)
- **TypeScript**: 6.x with `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noImplicitOverride`
- **Web**: [Vite 8](https://vite.dev) + [React 19](https://react.dev) + [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query) + [Base UI](https://base-ui.com) primitives + [Tailwind 4](https://tailwindcss.com) + [class-variance-authority](https://cva.style) + [lucide-react](https://lucide.dev)
- **Server bundle**: [tsdown](https://github.com/rolldown/tsdown) + [open](https://github.com/sindresorhus/open)
- **DB**: `bun:sqlite` (built-in, zero deps)
- **LLM**: bring your own — [OpenRouter](https://openrouter.ai) (recommended), OpenAI, or Anthropic

Plain `async/await` throughout — no monadic abstractions to learn before reading the code. Keeps the codebase forkable.

---

## Repository layout

```
oneshot-gtm/
├── apps/
│   ├── cli/         ~30-command CLI (commander)
│   ├── server/      Bun.serve + SSE — REST + /queue + /run + strategist + trigger fire-and-forget;
│   │                tsdown bundle, publishable as `oneshot-gtm-server`
│   └── web/         Vite + React 19 + TanStack + Base UI dashboard (8 pages + StrategistDock)
├── packages/
│   ├── core/        OneShot SDK wrapper, SQLite ledger, config + secrets, JSONL event log
│   ├── intel/       LLM client (OpenRouter/OpenAI/Anthropic), advise, personalize, triage, weekly-review
│   ├── plays/       13 outreach plays + handoff/icp/pmf modules + multichannel cadence engine
│   ├── find/        10 finders + shared pipeline (manifest scan, parallel infra, dedupe, ICP filter,
│   │                drain dispatcher, trigger registry)
│   ├── prompts/     Markdown prompt files (humanizer canon + per-play + per-extract prompts)
│   ├── doctor/      Wallet + ledger + key health checks
│   └── shared-types/ Wire types shared across CLI / server / web
├── examples/        Runnable target files for every motion play
├── launch/          Draft launch posts (HN, Bookface, IH, Twitter/X, Reddit)
├── docs/            Long-form docs
├── .github/workflows/release.yml   tag-driven npm publish for oneshot-gtm-server
├── turbo.json
├── vitest.config.ts
├── .oxlintrc.json
├── .oxfmtrc.json
├── tsconfig.base.json
└── package.json     (Bun workspaces with catalog)
```

---

## Development

```bash
bun install              # install everything
bun run typecheck        # tsc --noEmit across cli + server + packages
bun run lint             # oxlint
bun run fmt              # oxfmt --write
bun run fmt:check        # CI-style format check
bun run test             # vitest run (701 cases)
bun run cli -- doctor    # smoke check
```

The web app has its own typecheck because the TanStack Router file-based route tree gen requires a build step:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web build       # produces apps/web/dist/
```

Build the publishable server bundle (apps/server/dist/bin.mjs + dist/web/):

```bash
bun run --cwd apps/server build
```

### Watching what's happening

Every install writes a structured event log to `~/.oneshot-gtm/events.jsonl` — one JSON line per LLM call, ICP filter decision, finder lifecycle event, and swallowed `catch`. Local-only; never transmitted off-device. Tail with `jq` while iterating:

```bash
# Live tail, condensed
tail -f ~/.oneshot-gtm/events.jsonl | jq -c '{t:.ts, k:.kind, ctx:.ctx}'

# Just LLM calls (with durations)
tail -f ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind | startswith("llm."))'

# Just ICP classifier decisions (see WHY rejects happened)
tail -f ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind == "icp.decision")'

# Errors and warnings only
tail -f ~/.oneshot-gtm/events.jsonl | jq -c 'select(.level == "error" or .level == "warn")'

# All events from one run (grab a run_id from above, then)
tail -2000 ~/.oneshot-gtm/events.jsonl | jq -c 'select(.run_id == "PASTE-HERE")'

# Mirror to stderr too (in addition to file)
DEBUG=oneshot:* oneshot-gtm find watch --once
```

The event payload (`ctx`) is bound by a strict privacy boundary — primitives, counters, durations, hostnames only. No prospect data, no LLM completions verbatim, no user-typed values. See [TELEMETRY.md](./TELEMETRY.md) for the full schema.

---

## Distribution

Three install paths, picked for your use case:

**1. Repo clone (current)** — `git clone && bun install && bun run cli` / `bun run cli -- ui`. Best for hacking.

**2. Global link (one-time)** —

```bash
cd apps/cli && bun link && bun link oneshot-gtm && cd -
oneshot-gtm ...                  # works from anywhere
```

**3. npm-published binary** (for users who want the dashboard but don't want to clone):

```bash
bunx oneshot-gtm-server          # downloads + boots once
# or:
bun add -g oneshot-gtm-server
oneshot-gtm-server
```

Note: the published `oneshot-gtm-server` requires Bun runtime — it uses `bun:sqlite`, `Bun.serve`, and `Bun.stdin`. If invoked under plain `node` it fails loudly with an install hint.

---

## Telemetry

Anonymous, opt-out, one command to disable:

```bash
oneshot-gtm config telemetry off
# or set ONESHOT_GTM_TELEMETRY=0 in your env (hard kill at the call site)
```

Full disclosure of what's collected (and what's never collected) is in [TELEMETRY.md](./TELEMETRY.md). Nothing about your prospects, prompts, replies, receipts, or wallet ever leaves your machine.

---

## Out of scope (deliberately)

- **OneShot Cloud / Open Source universal dashboard** — separate future product that aggregates receipts/usage across vertical wrappers (`oneshot-gtm`, future `oneshot-support`, etc.). The dashboard here is single-user local-only by design.
- **`@oneshot/wrapper-kit` extraction** — deferred until a second wrapper exists.
- **Tauri / Electron desktop wrap** — `bunx oneshot-gtm-server` opens the system browser, that's enough for now.
- **Auth, multi-user, hosted DB** — local SQLite + chmod-600 dotfile stays. Cloud handles those concerns separately.
- **Effect ecosystem** — skipped for shipping speed; can adopt server-only later.

---

## Status

See [ROADMAP.md](./ROADMAP.md). Phases 0–2 (CLI), R0–R3 (monorepo + dashboard), F1–F2 (find layer + trigger UI), and most of F3 (strategist dock, trigger fire-and-forget, readiness gate, stale-run sweep) are shipped.

What's known to work end-to-end against the live OneShot API is in [STATUS.md](./STATUS.md).

---

## License

MIT. See [LICENSE](./LICENSE).

Read every prompt. Fork every play. We expect you to.

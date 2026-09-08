<img src="apps/web/public/icon-192.png" alt="" width="72" height="72" align="left" />

# oneshot-gtm

> Open-source GTM agent for technical founders. Pay-per-result, signed receipts, founder-led discipline encoded. Terminal CLI + local web dashboard over one SQLite ledger.

**[oneshot-gtm.com](https://oneshot-gtm.com)** · [what a signed receipt is](https://oneshot-gtm.com/receipt) · [docs](https://docs.oneshotagent.com/oneshot-gtm/introduction)

```bash
bunx oneshot-gtm-server     # dashboard only — published, no clone
```

[![Built with oneshot-sdk](https://img.shields.io/badge/built%20with-oneshot--sdk-0a0a0a?style=flat&labelColor=18181b&color=22c55e)](https://www.npmjs.com/package/@oneshot-agent/sdk) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![Bun](https://img.shields.io/badge/runtime-Bun%201.3+-fbf0df?logo=bun&logoColor=black)](https://bun.sh) [![TypeScript](https://img.shields.io/badge/typed-TypeScript%206-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

https://github.com/user-attachments/assets/bba2fb2d-35c3-4171-a358-fd3a987c24bc

---

## What this is

[OneShot](https://docs.oneshotagent.com) is a pay-per-use API toolbox — email, SMS, voice, deep research, person enrichment, browser automation, website build — settled per call in USDC on Base, with a cryptographically signed receipt for every action.

`oneshot-gtm` is the strategy wrapper. It encodes the founder-led-sales playbook — Mom Test, Sean Ellis 40%, Predictable Revenue, do-things-that-don't-scale, multichannel cadence, signed-receipt CAC — as named **plays** you run from the terminal or the dashboard. Finders watch public signals, an ICP gate filters what they find, you approve rows in a queue, plays draft and send, cadences follow up, and every dollar lands in a receipt you can attribute to an outcome.

MIT, so you can read every prompt, fork every play, and trust what's running.

### Why not Apollo / Clay / Outreach / Smartlead

|                   | Them                                 | oneshot-gtm                               |
| ----------------- | ------------------------------------ | ----------------------------------------- |
| Pricing           | Seat-based SaaS, $$/seat/mo          | Pay-per-result, no subscription           |
| Source visibility | Closed; you trust the dashboard      | MIT; read the prompts, fork the plays     |
| CAC story         | Blended, estimated, dashboard-shaped | Signed per-call receipts, exportable      |
| PMF posture       | Assumes PMF, optimizes sends         | Pre-PMF aware, soft-gates on scale moves  |
| LLM               | Built-in, opaque                     | BYO key (OpenRouter / OpenAI / Anthropic) |
| State             | Vendor cloud                         | Local SQLite + chmod-600 dotfile          |

Most GTM tools assume you have product-market fit and optimize sends. Most pre-PMF founders don't, and end up scaling a broken motion because the tool said "send more" — the [Startup Genome Report](https://startupgenome.com)'s top documented cause of startup death. So the discipline is built in:

- Plays default to founder-to-founder voice, low volume (≤50/day), one touch unless you invoke the cadence engine.
- Every first touch is Hook → Identity → Offer → CTA. The Offer says the useful thing in the email, for free; the CTA asks for one line the reader can answer from their own experience, or asks for nothing. It never asks a stranger for a meeting. One true concession you write in config (`founderAdmission`) is worked into roughly a third of first touches; leave it blank and the beat is skipped, never invented.
- Every draft passes a lint built on the Wikipedia "Signs of AI writing" canon — banned phrases, em dashes, AI vocabulary, three-item lists, sycophantic openers.
- Scale-move commands (`handoff templatize`, `first-ae`, `readiness`) print soft-gate checklists and default to "not yet, fix this first" until the signals earn the move. `--force` overrides.
- Every paid action emits a signed receipt carrying a **memo** (why the call happened), structured `decisionContext`, and a `goalId` grouping a cadence's spend. When a reply or deal outcome lands, that value is tagged back, so CAC and RoCS on the Measure page are attestable and outcome-attributed, not estimated.

---

## Setup

```bash
curl -fsSL https://bun.sh/install | bash        # Bun is the required runtime

git clone https://github.com/oneshot-agent/oneshot-gtm
cd oneshot-gtm && bun install

bun run cli -- init                             # config + keys wizard
bun run cli -- doctor                           # sanity check
bun run --cwd apps/web build                    # one-time: build the SPA
bun run cli -- ui                               # http://127.0.0.1:3030
```

`init` asks for the founder profile the prompts draw on: background that builds trust, products you've shipped, notable partners or customers, and one true concession. All optional — a blank field skips the beat that uses it rather than improvising. Edit any of them later from `/setup` or `config founder`. [What reaches the model, and when](./docs/prompt-inputs.md) maps each field to the surfaces it shapes.

Some finders need keys `init` never asks about — most people want `GITHUB_TOKEN` (a classic token with no scopes) before enabling the GitHub finders. `/setup` and `config keys` store them; [finders](./docs/finders.md#finder-specific-keys) lists them.

To call it from anywhere: `cd apps/cli && bun link && bun link oneshot-gtm && cd -`. Prefer the dashboard without cloning? `bunx oneshot-gtm-server` downloads and boots it. Bun is still required — the bundle uses `bun:sqlite` and `Bun.serve`, and fails loudly under plain `node`. The CLI itself is not published to npm.

---

## The two surfaces

Both read and write the same `~/.oneshot-gtm/ledger.sqlite`.

### Terminal

```bash
bun run cli -- intel advise                        # interactive coach
bun run cli -- find watch --once                   # poll due triggers, enqueue candidates
bun run cli -- find drain podcast-guest --dry-run  # preview approved /queue rows
bun run cli -- cadence advance                     # daily tick: poll inbox, fire follow-ups
```

67 commands — `bun run cli -- --help` (or `oneshot-gtm --help` once linked) is the reference:

| Group                    | Commands                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init` · `doctor` · `ui` | setup wizard · health check · open the dashboard                                                                                                                                                                                                                                                                                          |
| `config`                 | `llm` · `founder` · `keys` · `telemetry on\|off` · `slack-webhook [url]` · `x-engine [engine]` · `spend-ceiling [amount\|off]`                                                                                                                                                                                                            |
| `identities`             | `list` · `add` · `remove <id>` — the sender pool                                                                                                                                                                                                                                                                                          |
| `gmail`                  | `auth` (OAuth a sending account) · `placement` (inbox-placement canary)                                                                                                                                                                                                                                                                   |
| `smartlead`              | `connect` — API key + pick Smartlead mailboxes into the pool (send-only)                                                                                                                                                                                                                                                                  |
| `domains`                | `list` · `pause <domain>` · `resume <domain>` — provisioned OneShot domains                                                                                                                                                                                                                                                               |
| `find`                   | `watch` · `drain <play>` · `import --csv <file> --play <name>` · `enrich-linkedin` · `research-prospects` · `research-products` · `synthesize-angles` · `score-prospects` · `calibrate` — `--fail-on-empty` makes `watch --once` and `drain` [exit 2 on a run that produced nothing](#background-monitoring-as-a-service) |
| `motion`                 | `post-funding` `concierge` `demo-no-show` `competitor-switch` `hiring-signal` `podcast-guest` `discovery-interview` `free-pilot` — each takes `--target <file>`; `breakup-revive` reads the ledger                                                                                                                                        |
| `cadence`                | `advance` — poll inbound, fire due steps                                                                                                                                                                                                                                                                                                  |
| `direct-mail`            | `list` · `upload` · `preview` · `refresh` · `approve` · `send` · `cancel` — individual physical-mail approvals                                                                                                                                                                                                                            |
| `discover`               | `icp interview-prep` · `icp synthesize` · `pmf classify` · `pmf survey` · `pmf survey-collect`                                                                                                                                                                                                                                            |
| `measure`                | `benchmark` — compare this install's command activity with the opt-in telemetry cohort; supports `--json`                                                                                                                                                                                                                                |
| `intel`                  | `advise` · `personalize` · `triage-replies` · `backfill-intent` · `weekly-review`                                                                                                                                                                                                                                                         |
| `handoff`                | `readiness` · `templatize` · `first-ae`                                                                                                                                                                                                                                                                                                   |
| `demo`                   | `seed` · `ui` · `reset` — a fictional install for screenshots and video                                                                                                                                                                                                                                                                   |
| `workspace`              | `list` · `create <name>` · `use <name>` · `current` · `path <name>` · `remove <name>` — one isolated install per product; `--workspace <name>` on any command                                                                                                                                                                            |

Spend, CAC, RoCS and outcome logging live in the dashboard's Measure and Cadences pages so there's one source of truth. Add `--json` to a read-only command (`doctor`, `identities list`, `domains list`, `workspace list`) for machine-readable output, or script the `/api/measure/*` routes.

### Dashboard

```bash
bun run cli -- ui [--dev] [--port 4000] [--no-browser]
```

Ten pages plus a run form:

- **Home** — spend, reply-rate trend, in-flight cadences, and a scheduler strip showing each trigger's state, last run and next due
- **Queue** — triggers table (enable, edit config, fire) plus the target queue with bulk approve and per-play **Drain**
- **Prospects** — search and browse every candidate a finder ever surfaced, any status, with who decided it and why, what happened after, and an override
- **Add Prospect** — paste a LinkedIn / X / GitHub URL; deep research builds a dossier, the LLM picks an angle against your ICP and drafts an intro, and the row lands in the queue
- **Replies** — every reply matched to its prospect, play and cadence status across all sender identities; answer in place, by hand or LLM-drafted and research-grounded
- **Cadences** — stop, log outcome, preview the next step, batch send email, and [review/send direct mail](#direct-mail) per prospect
- **Receipts** — paginated, with the memo and value chip per call; click through to the signed payload
- **Plays** — cards with channel badges, a Run button, Copy CLI, and optional [direct-mail steps](#direct-mail)
- **Measure** — CAC and RoCS by time range, plus per-cadence spend vs tagged value grouped by goal
- **Setup** — founder profile, ICP, product brief, LLM provider, wallet keys, sender identities, telemetry toggle
- **Run a play** (`/run/$playName`) — editable target rows, dry-run toggle, drafts streamed back over SSE with lint flags and receipt links

A floating strategist dock on every page reads your ICP and product one-liner and proposes trigger configs as confirmation chips. Next to it, a privacy toggle masks names, emails, companies and phone numbers for screenshots. [Demo mode](./docs/demo-mode.md) seeds a fictional, fully-populated install for the same purpose.

---

## Where targets come from

Fifteen **finders** discover prospects, ICP-filter them, and enqueue into `/queue` for one-click approve or reject. Each runs as a trigger with its own interval and spend cap; the dashboard server runs the scheduler in-process, so enabling a trigger is enough.

| Finder              | Signal                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show-hn`           | same-day Show HN posts, via the HN Algolia API                                                                                                                                                                                                     |
| `post-funding-auto` | funding announcements by ICP-derived industry × round                                                                                                                                                                                              |
| `accelerator-batch` | new cohorts — yc-oss directory, websearch fallback for Techstars / Antler / 500 / AI Grant                                                                                                                                                         |
| `job-change`        | `joined as <persona>` announcements, filtered by persona and company                                                                                                                                                                               |
| `hiring-signal`     | open roles on Greenhouse / Lever / Workable / Ashby implying a need                                                                                                                                                                                |
| `podcast-guest`     | recent guests across Latent Space, Lenny's, 20VC, Acquired, Invest Like the Best                                                                                                                                                                   |
| `github-topics`     | repos by topic, then a manifest scan that detects the vendor stack deterministically — needs `GITHUB_TOKEN`                                                                                                                                        |
| `github-stars`      | recent stargazers of repos you watch; tag each repo `competitor` or `adjacent` to route the play — needs `GITHUB_TOKEN`                                                                                                                            |
| `luma-events`       | upcoming events from Luma's city pages, gated per event by a topic + ICP check before any spend; pitches the hosts and featured guests                                                                                                             |
| `gov-solicitation`  | SAM.gov Sources Sought / Presolicitation notices by NAICS code via the SDK's `govSolicitations`; pitches the notice's published contracting officer, no lookup spend and no key                                                                    |
| `civic-agenda`      | city/county council agenda items via the Legistar/Granicus API, keyword-gated free before any paid call; pitches the meeting body's published contact                                                                                              |
| `breakup-revive`    | your own ledger — prospects cold for 60–90 days. No LLM or OneShot spend                                                                                                                                                                           |
| `x-reposters`       | people who repost/quote X accounts you watch, in two lanes: builders who'd adopt (email cadence) and dev accounts with reach who'd boost a launch (one-touch email, or a hand-sent DM draft) — needs X API keys or `TWITTERAPI_IO_KEY`             |
| `local-business`    | main-street businesses via `peopleSearch`/`companySearch` (job title × industry × location × company size), or the SDK's `localSearch` places index with `engine: local` — routed to the `free-pilot` play                                         |
| `local-registry`    | newly-licensed main-street businesses over free public registries (Socrata business licenses, NPPES NPI, FMCSA Company Census), resolved to a domain with the SDK's `localResolve` — recent matches route to `new-business`, older to `free-pilot` |

Only `show-hn` and `post-funding-auto` are on by default. Two ICP gates run per candidate: a **topic gate** on the source, before any spend, and a **person gate** on the human's role, staged by cost and judging capability to build and self-adopt rather than seniority. Only a positive reject drops a candidate; rejections land in `/queue` as auditable rows you can override. [Finders](./docs/finders.md) covers the prescreen, the gates, product research and review ordering.

### The plays

Twenty-three of them. Thirteen have a **Run** page in the dashboard and drain from the queue:

`show-hn` · `job-change` · `post-funding` · `accelerator-batch` · `hiring-signal` · `podcast-guest` · `competitor-switch` · `stack-consolidation` · `repo-interest` · `luma-events` · `sources-sought` · `civic-pilot` · `design-partner-loi`

The last three are the institutional counterparts to the founder-to-founder register: `sources-sought` cites a specific SAM.gov notice and agency, `civic-pilot` cites a council agenda item, meeting date and a cooperative purchasing vehicle, and `design-partner-loi` walks an ask ladder — conversation, scoped pilot, non-binding LOI — for enterprise, government and hardware buyers, and refuses to draft at an owner-operator.

Six more drain from the queue without a Run form — `profile-intro` (what Add Prospect enqueues), `breakup-revive`, `free-pilot`, and the three `x-reposters` feeds: `x-repost-intro`, `x-amplify`, and `x-amplify-dm`, the one play that never auto-sends (it drafts DM text you send by hand, then **Mark sent** records the touch). `concierge` and `demo-no-show` are CLI-only because they open with a voice call and an SMS respectively; both are fed by [trigger webhooks](./docs/webhooks.md).

Most carry a cadence — a value follow-up, then a breakup, over roughly three to nine days, editable per play from `/plays`. Any reply, email or LinkedIn, stops every live cadence for that prospect. You can also stop one deliberately from `/cadences` with a reason: bad-timing stops become breakup-revive candidates after the cold window, not-a-fit and do-not-contact stay excluded.

### Direct mail

An optional, individually approved physical-letter step. **Plays → Direct mail** picks eligible prospects per motion (a named person, a company, and a complete U.S. business address); **Cadences → Review mail** generates or uploads the letter, shows the print proof and price, and sends on approval. Bulk actions never send mailpieces. [Direct mail](./docs/direct-mail.md) has the selection rules and timing.

### Background monitoring as a service

`find watch --install-service` generates a launchd agent (macOS) or systemd user unit (Linux) that keeps the watch daemon running; Windows schedules `find watch --once`. `--fail-on-empty` makes a clean-but-empty run exit `2`, so a cron wrapper can tell idle from broken. `config spend-ceiling` caps what all finders and drains may spend per day; manual sends are never gated by it. [Background monitoring](./docs/background-monitoring.md) has the service files, exit codes and ceiling semantics.

---

## Sending

Outbound ships through a **sender identity pool** — any mix of OneShot wallet-owned sending domains, your own Gmail / Workspace accounts, and Smartlead-hosted mailboxes (send-only). Every email to a prospect comes from the identity that sent their first touch. New identities ramp 10/day, +10/week, to a 50 ceiling, per domain; when every identity is at cap, nothing sends over it — steps stay due until midnight. The inbox poll merges the OneShot inbox with every authorized Gmail account, so stop-on-reply works whichever identity sent, and replies from `/inbox` thread on both transports.

Bounces are harvested from Gmail mailboxes and classified; a hard bounce stops the cadence and suppresses the address. `gmail placement` sends one real canary between two of your mailboxes and reports where it landed, with the SPF/DKIM/DMARC verdicts — no DNS tooling. [Sending and deliverability](./docs/sending.md) has the full rules.

## Workspaces

One install is one product: one founder voice, one ICP, one product brief, one ledger, one sender pool. A fresh install is a single workspace named `default`. Selling a second product means a second workspace with its own profile, keys, identities and dashboard port:

```bash
bun run cli -- workspace create acme          # its own home under ~/.oneshot-gtm-workspaces
bun run cli -- --workspace acme init          # profile, keys, identities
bun run cli -- --workspace acme ui            # side by side with the default dashboard
```

Workspaces share one thing: `~/.oneshot-gtm-shared/shared.sqlite`, holding the paid lookup caches and contact touches, so the same person is never bought twice and never first-touched by two workspaces within 7 days. [Workspaces](./docs/workspaces.md) covers resolution order, the shared DB, `doctor`'s cross-workspace checks and the dashboard switcher.

---

## Architecture

```
   ┌──────────────────────────────────────────────┐
   │  apps/cli    apps/server      apps/web       │   ← surfaces
   │  commander   Bun.serve+SSE    Vite+React     │
   └───────────────────────┬──────────────────────┘
                           │
   ┌───────────────────────┴──────────────────────┐
   │  packages/*  — the brains, shared by all 3   │
   │  core · intel · plays · find · prompts ·     │
   │  doctor · shared-types                       │
   └───────────────────────┬──────────────────────┘
                           ▼
   ┌──────────────────────────────────────────────┐
   │  @oneshot-agent/sdk — OneShot primitives     │
   │  email · SMS · voice · research · enrichment │
   │  browser · build · signed receipts           │
   └──────────────────────────────────────────────┘
```

**State** — one `~/.oneshot-gtm/ledger.sqlite` is the source of truth for all three surfaces: receipts, prospects, sequence events, cadence state, deal outcomes, interviews, target queue, triggers, bounces, and sender assignments. `ONESHOT_GTM_HOME` relocates the whole directory.

**Secrets** — `~/.oneshot-gtm/.env`, chmod 600, auto-loaded on first import.

**Server** — single-user, local-first, binds `127.0.0.1` only. Dashboard routes rely on that local boundary. Two [webhook](./docs/webhooks.md) families accept outside input: signed trigger intake (signup, demo no-show) and a bearer-authenticated LinkedIn reply endpoint.

**Data underneath** — enrichment, verification and local lookups resolve through OneShot, which maintains a vendor landscape of 50 data sources across six categories (contact enrichment, company data, email verification, maps and places, browser automation, social). Which source answers a given lookup is chosen per call. [The full catalogue](https://docs.oneshotagent.com/vendors).

```
apps/
  cli/        the 67-command CLI (commander); src/demo/ seeds the demo install, src/main.ts picks the workspace
  server/     Bun.serve + SSE; tsdown bundle published as `oneshot-gtm-server`
  web/        Vite + React 19 + TanStack + Base UI — 9 pages, run form, strategist dock, privacy mode
packages/
  core/       SDK wrapper, SQLite ledger, config + secrets, Gmail transport, JSONL events
  intel/      LLM client, advise, personalize, triage, weekly-review
  plays/      23 outreach plays + handoff/icp/pmf modules + cadence engine
  find/       15 finders + shared pipeline (manifest scan, dedupe, ICP filter, drain, registry)
  prompts/    Markdown prompts — humanizer canon, per-play, per-extract
  doctor/     Wallet, ledger, key and deliverability health checks
  shared-types/  Wire types shared across CLI / server / web
docs/         Guides: workspaces, finders, sending, direct mail, background monitoring, webhooks, demo mode, prompt inputs
examples/     Sample target files for nine plays
vendor/       The pinned SDK archive core and server install from
```

**Stack** — Bun 1.3+ · Turborepo with a Bun catalog · Vitest 4 · oxlint + oxfmt · TypeScript 6 (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noImplicitOverride`) · Vite 8 + React 19 + TanStack Router/Query + Base UI + Tailwind 4 · tsdown for the server bundle · `bun:sqlite` · BYO LLM via OpenRouter, OpenAI or Anthropic. Plain `async`/`await` throughout — no monadic abstractions to learn before reading the code.

---

## Development

```bash
bun install
bun run typecheck                  # tsc --noEmit across cli + server + packages
bun run lint                       # oxlint
bun run fmt                        # oxfmt --write   (fmt:check in CI)
bun run test                       # vitest — current totals in STATUS.md
bun run cli -- doctor              # smoke check
```

The web app typechecks separately, because TanStack's file-based route tree needs a build step first:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web build       # → apps/web/dist/
bun run --cwd apps/server build    # → apps/server/dist/bin.mjs + dist/web/
```

The suite is 3323 cases across 255 files (STATUS.md carries the current totals). Tests set `ONESHOT_GTM_HOME` to a temp dir, so they never touch your real ledger. CI runs `bun --bun run test` — the flag matters, since `bun:sqlite` doesn't exist under Node. Core and server install the SDK from the archive in `vendor/`; its README has the coordinated release step.

### Watching what's happening

Every install writes a structured event log to `~/.oneshot-gtm/events.jsonl` — one line per LLM call, ICP decision, finder lifecycle event and swallowed `catch`. Local-only, never transmitted; the `ctx` payload is primitives, counters, durations and hostnames only.

```bash
tail -F ~/.oneshot-gtm/events.jsonl | jq -c '{t:.ts, k:.kind, ctx:.ctx}'          # condensed
tail -F ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind|startswith("llm."))'    # LLM calls
tail -F ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind=="icp.decision")'       # topic-gate rejects
tail -F ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind=="icp.person_decision")' # person-gate verdicts
tail -F ~/.oneshot-gtm/events.jsonl | jq -c 'select(.level=="error" or .level=="warn")'
tail -2000 ~/.oneshot-gtm/events.jsonl | jq -c 'select(.run_id=="PASTE-HERE")'    # one run
DEBUG=oneshot:* oneshot-gtm find watch --once                                     # mirror to stderr
```

The file rotates at about 10 MB into `events.1.jsonl` … `events.3.jsonl` (override with `ONESHOT_GTM_MAX_EVENT_LOG_BYTES`); `tail -F` survives the rotation, `tail -f` doesn't.

---

## Telemetry

Anonymous, opt-out, one command to disable:

```bash
oneshot-gtm config telemetry off        # or ONESHOT_GTM_TELEMETRY=0
```

One summary event per invocation: command, flags, outcome, duration, version, OS. [TELEMETRY.md](./TELEMETRY.md) is the authoritative field spec. Nothing about your prospects, prompts, replies, receipts or wallet leaves your machine.

---

## Status and scope

[STATUS.md](./STATUS.md) lists what isn't yet proven against the live API. [ROADMAP.md](./ROADMAP.md) lists what isn't built — and, at the bottom, the things this deliberately will never do (run an SDR, manage your DNS, hold your customer data, lock you to an LLM, go multi-user).

## License

MIT. See [LICENSE](./LICENSE).

Read every prompt. Fork every play. We expect you to.

---

Built by [free.butter](https://freebutter.com) — the lead infrastructure behind this
is the same pipeline that runs there.

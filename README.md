# oneshot-gtm

> Open-source GTM agent for technical founders. Pay-per-result, signed receipts, founder-led discipline encoded. Terminal CLI + local web dashboard over one SQLite ledger.

```bash
bunx oneshot-gtm-server     # dashboard only — published, no clone
```

[![Built with oneshot-sdk](https://img.shields.io/badge/built%20with-oneshot--sdk-0a0a0a?style=flat&labelColor=18181b&color=22c55e)](https://www.npmjs.com/package/@oneshot-agent/sdk) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![Bun](https://img.shields.io/badge/runtime-Bun%201.3+-fbf0df?logo=bun&logoColor=black)](https://bun.sh) [![TypeScript](https://img.shields.io/badge/typed-TypeScript%206-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

https://github.com/user-attachments/assets/bba2fb2d-35c3-4171-a358-fd3a987c24bc

---

## What this is

[OneShot](https://docs.oneshotagent.com) is a pay-per-use API toolbox — email, SMS, voice, deep research, person enrichment, browser automation, website build — settled per call in USDC on Base, with a cryptographically signed receipt for every action.

`oneshot-gtm` is the strategy wrapper. It encodes the canonical PMF and founder-led-sales playbook — Mom Test, Sean Ellis 40%, Predictable Revenue, do-things-that-don't-scale, multichannel cadence, signed-receipt CAC — as named **plays** you run from the terminal or the dashboard.

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

Most GTM tools assume you have product-market fit and optimize sends. Most pre-PMF founders don't, and end up scaling a broken motion because the tool said "send more" — which the [Startup Genome Report](https://startupgenome.com) cites as the top documented cause of startup death. So the discipline is built in:

- Plays default to founder-to-founder voice, low volume (≤50/day), one touch unless you invoke the cadence engine.
- Every first touch is Hook → Identity → Offer → CTA. The Offer says the useful thing in the email, for free; the CTA asks for one line the reader can answer from their own experience, or asks for nothing. It never asks a stranger for a meeting — "open to compare notes?" is banned, because it needs the reader to already believe a conversation with you is worth their time. Optionally, one true concession you write in config (`founderAdmission`) is worked into roughly a third of first touches as a damaging admission; leave it blank and the beat is skipped, never invented.
- Every draft passes a lint pass built on the Wikipedia "Signs of AI writing" canon — banned phrases, em dashes, AI vocabulary, three-item lists, sycophantic openers.
- Scale-move commands (`handoff templatize`, `first-ae`, `readiness`) print soft-gate checklists and default to "not yet, fix this first" until the signals earn the move. `--force` overrides.
- Every paid action emits a signed receipt carrying a **memo** (why the call happened), structured `decisionContext`, and a `goalId` grouping a cadence's spend. When a reply or deal outcome lands, that value is tagged back — so CAC and RoCS on the Measure page are attestable and outcome-attributed, not estimated.

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

`init` also asks for the founder profile the prompts draw on: background that builds trust, products you've shipped, notable partners or customers, and one true concession. All optional — when a field is blank, the beat that uses it is skipped rather than improvised. Edit any of them later from `/setup` or `config founder`.

To call it from anywhere: `cd apps/cli && bun link && bun link oneshot-gtm && cd -`. If you linked before workspaces landed, re-run that — the bin target moved to the bootstrap shim (`src/main.ts`).

Prefer the dashboard without cloning? `bunx oneshot-gtm-server` downloads and boots it. Bun is still required — the bundle uses `bun:sqlite` and `Bun.serve`, and fails loudly with an install hint under plain `node`. The CLI itself is not published to npm.

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

47 commands — twelve groups, plus `init`, `doctor` and `ui` at the top level. `bun run cli -- --help` (or `oneshot-gtm --help` once linked) is the reference:

| Group                    | Commands                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init` · `doctor` · `ui` | setup wizard · health check · open the dashboard                                                                                                                |
| `config`                 | `llm` · `founder` · `keys` · `telemetry on\|off`                                                                                                                |
| `gmail`                  | `auth` (OAuth a sending account) · `placement` (inbox-placement canary)                                                                                         |
| `identities`             | `list` · `add` · `remove <id>` — the sender pool                                                                                                                |
| `domains`                | `list` · `pause <domain>` · `resume <domain>` — provisioned OneShot domains                                                                                     |
| `find`                   | `watch` · `drain <play>` · `enrich-linkedin`                                                                                                                    |
| `motion`                 | `post-funding` `concierge` `demo-no-show` `competitor-switch` `hiring-signal` `podcast-guest` — each takes `--target <file>`; `breakup-revive` reads the ledger |
| `cadence`                | `advance` — poll inbound, fire due steps                                                                                                                        |
| `discover`               | `icp interview-prep` · `icp synthesize` · `pmf classify` · `pmf survey` · `pmf survey-collect`                                                                  |
| `intel`                  | `advise` · `personalize` · `triage-replies` · `weekly-review`                                                                                                   |
| `handoff`                | `readiness` · `templatize` · `first-ae`                                                                                                                         |
| `demo`                   | `seed` · `ui` · `reset` — a fictional install for screenshots and video                                                                                         |
| `workspace`              | `list` · `create <name>` · `use <name>` · `current` · `path <name>` · `remove <name>` — one isolated install per product; `--workspace <name>` on any command   |

Spend, CAC, RoCS and outcome logging deliberately have no CLI group — they live on the dashboard's Measure and Cadences pages so there's one source of truth. The `/api/measure/*` routes are there if you'd rather script them.

### Dashboard

```bash
bun run cli -- ui [--dev] [--port 4000] [--no-browser]
```

Nine pages plus a run form:

- **Home** — spend, reply-rate trend, in-flight cadences, and a scheduler strip showing each trigger's state, last run and next due
- **Queue** — triggers table (enable, edit config, fire) plus the target queue with bulk approve and per-play **Drain**
- **Add Prospect** — paste a LinkedIn / X / GitHub URL; `deepResearchPerson` builds a dossier, the LLM picks an angle against your ICP and drafts an intro, and the row lands in the queue
- **Replies** — every reply matched to its prospect, play and cadence status across all sender identities; answer in place, by hand or LLM-drafted. Drafting is research-grounded: known prospects reuse their stored dossier, unknown senders get enriched + their site read (~$0.06, cached 30 days, receipted under `inbox-reply`), and replies may cite links from your product brief — never invented ones
- **Cadences** — stop, log outcome, preview the next step, batch send
- **Receipts** — paginated, with the memo and value chip per call; click through to the signed payload
- **Plays** — cards with channel badges, a Run button, and Copy CLI
- **Measure** — CAC and RoCS by time range, plus per-cadence spend vs tagged value grouped by goal
- **Setup** — founder profile, ICP, product brief (facts + the only links replies may cite, derivable from your site/repo/docs), LLM provider, wallet keys, sender identities, telemetry toggle
- **Run a play** (`/run/$playName`) — editable target rows, dry-run toggle, drafts streamed back over SSE with lint flags and receipt links

A floating strategist dock sits on every page: it reads your ICP and product one-liner and proposes trigger configs as confirmation chips (`POST /api/strategist/stream`, SSE).

Next to it is a **privacy toggle**. Flip it on and names, emails, companies and phone numbers render partially masked everywhere — enough to screenshot a receipt or a cadence without exposing a real contact. Costs, receipt IDs and every other figure stay untouched, since the numbers are the reason to show a receipt in the first place. Off by default, remembered per browser. It's readable obfuscation for screenshots, not secure redaction.

### Demo mode

A fresh install is nine empty states, which makes it hard to show anyone what this looks like in use. `demo` builds a fictional, fully-populated install in its own home and opens the dashboard against it.

```bash
bun run cli -- demo seed      # → ~/.oneshot-gtm-demo
bun run cli -- demo ui        # dashboard, pointed at the demo install
bun run cli -- demo reset     # delete it
```

The cast is invented (it extends the one in `examples/`) and the numbers are internally consistent: ~24 prospects across eight plays and 30 days, 147 signed receipts totalling $2.94, cadences in all five states, replies matched to their prospects, two closed deals. Everything is anchored to a timestamp, so `--now` reproduces a ledger exactly and a re-shoot matches the first take.

What demo mode changes, and nothing else:

- Four **read-only** calls that fetch at request time rather than reading the ledger — the reply list, the platform RoCS rollup, the domain pool, the wallet balance — are served from JSON fixtures in the demo home. Without that, Replies is blank no matter what's in SQLite.
- The in-process **scheduler idles**, so enabled triggers don't fire against the demo install and overwrite its state mid-screenshot.

Nothing that sends, drafts or spends is faked. Under the flag, the demo home's `.env` is the **sole** source of secrets — real credentials inherited from your shell, your install, or a repo-root `.env` are overwritten or deleted — so a stray click on Run or Send fails at auth rather than doing something real. `demo seed` refuses to touch `~/.oneshot-gtm`, and `demo reset` only removes a directory it marked as its own.

---

## Workspaces

One install is one product: one founder voice, one ICP, one product brief, one ledger, one sender pool. Selling two things — or running the OneShot motion _and_ the oneshot-gtm adoption motion — means two workspaces:

```bash
bun run cli -- workspace create gtm          # ~/.oneshot-gtm-workspaces/gtm, dashboard :3031
bun run cli -- --workspace gtm init          # its own profile, keys, identities
bun run cli -- --workspace gtm ui            # runs side by side with the default on :3030
bun run cli -- workspace use gtm             # make it the default for runs without the flag
```

`--workspace` (or `ONESHOT_GTM_WORKSPACE`) is resolved by a bootstrap shim before anything else loads, so every command and the spawned dashboard see the right home. An explicit `ONESHOT_GTM_HOME` still wins — it's the escape hatch, and `workspace path <name>` prints a home for scripting (`ops/expandi-sync` reads it that way).

What stays **shared** across workspaces lives in `~/.oneshot-gtm-shared/shared.sqlite`: the paid lookup caches (enrichment, LinkedIn — the same person is never bought twice) and contact touches. A workspace never first-touches someone another workspace emailed in the last 7 days: the draft holds with a `contacted-elsewhere` flag you can override on a manual send, while drain and cadence steps wait the window out.

`doctor` warns when two workspaces share a sending domain (warm-up caps are per-workspace, so the domain's real budget silently doubles) or a Gmail account (both inbox pollers would see both products' replies), and the dashboard masthead names the workspace you're in.

---

## Where targets come from

Ten **finders** discover prospects, ICP-filter them, and enqueue into `/queue` for one-click approve or reject. Each runs as a trigger with its own interval and spend cap.

| Finder              | Signal                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show-hn`           | same-day Show HN posts, via the HN Algolia API                                                                                                                   |
| `post-funding-auto` | funding announcements by ICP-derived industry × round                                                                                                            |
| `accelerator-batch` | new cohorts — yc-oss directory, websearch fallback for Techstars / Antler / 500 / AI Grant                                                                       |
| `job-change`        | `joined as <persona>` announcements, filtered by persona and company                                                                                             |
| `hiring-signal`     | open roles on Greenhouse / Lever / Workable / Ashby implying a need                                                                                              |
| `podcast-guest`     | recent guests across Latent Space, Lenny's, 20VC, Acquired, Invest Like the Best                                                                                 |
| `github-topics`     | repos by topic, then a manifest scan (`package.json`, `pyproject.toml`, `requirements.txt`) that detects the vendor stack deterministically                      |
| `github-stars`      | recent stargazers of repos you watch; tag each repo `competitor` or `adjacent` to route the play                                                                 |
| `luma-events`       | upcoming events from Luma's own city pages, gated per event by a topic + ICP check before any spend; pitches the hosts and featured guests Luma exposes publicly |
| `breakup-revive`    | your own ledger — prospects cold for 60–90 days. No LLM or OneShot spend                                                                                         |

Only `show-hn` and `post-funding-auto` are on by default; enable the rest from `/queue`. A trigger missing required config reads as **not ready** — the toggle and Run button disable with the reason, and the API returns `409`, so scripted callers can't bypass the gate either.

Before any paid `findEmail`, a prescreen skips dud domains (`*.vercel.app`, social hosts, link aggregators, personal email providers) and inputs whose "name" is obviously a username. LinkedIn URLs are captured on every finder path and verified to belong to the person before they're stored.

The dashboard server runs an in-process scheduler, so enabling a trigger is enough — no separate daemon. `find watch` stays useful for cron and headless boxes. Approved rows ship via the **Drain** button or `find drain <play>`.

### The plays

Fourteen of them. Ten have a **Run** page in the dashboard and drain from the queue:

`show-hn` · `job-change` · `post-funding` · `accelerator-batch` · `hiring-signal` · `podcast-guest` · `competitor-switch` · `stack-consolidation` · `repo-interest` · `luma-events`

Two more drain from the queue without a Run form — `profile-intro` (what Add Prospect enqueues) and `breakup-revive`. The last two, `concierge` and `demo-no-show`, are CLI-only because they open with a voice call and an SMS respectively.

Most carry a cadence — a value follow-up, then a breakup, spread over roughly three to nine days and editable per play from `/plays`. Any reply stops the sequence — and is recorded whether the sequence is still running, already finished, or never existed (one-touch plays like `luma-events`), credited to the play whose subject it threads on.

---

## Sending

Outbound ships through a **sender identity pool** — any mix of OneShot wallet-owned sending domains (several domains, several mailboxes per domain) and your own Gmail / Workspace accounts.

- **Sticky threads.** Every email to a prospect comes from the identity that sent their first touch, across plays and cadence steps. In-flight conversations never switch From address.
- **Warm-up caps, per domain.** A new identity ramps 10/day, +10/week, to a 50 ceiling — editable per identity on `/setup`. OneShot reputation is per-domain, so every mailbox on a domain shares one ramp and budget. Gmail accounts ramp per account.
- **Defer, never exceed.** When every identity is at cap, cadence steps stay due and queue rows stay approved until midnight. Nothing sends over cap.
- **Two products, one founder, one inbox.** A workspace (see Workspaces) never first-touches someone another workspace emailed in the last 7 days: the draft is held with a `contacted-elsewhere` flag that you can override on a manual send, and auto paths (drain, cadence steps) wait the window out. Touches and the paid lookup caches live in one shared SQLite (`~/.oneshot-gtm-shared/`), so the same person is never researched twice across products.
- **Replies follow the pool.** The inbox poll merges the OneShot inbox with every authorized Gmail account, so stop-on-reply works whichever identity sent. It walks everything since its last clean poll — a persisted watermark with an hour of overlap, paged newest-first, parking anything beyond one poll's page budget as a backlog the next ticks drain — so a reply is delayed by an outage, never lost to it. A reply you've already read and archived still counts. Answering from `/inbox` records the reply too, replies from the receiving identity, and threads on both transports — Gmail via `In-Reply-To`/`References`, OneShot via `reply_to_email_id`. Sends carry an idempotency key, so a retry after a timeout can't double-send.

Add a OneShot domain and mailbox from `/setup` or `identities add` — pick a provisioned domain or type a new one to auto-provision on first send. Add a Gmail account with `gmail auth` (one-time OAuth; needs a Google Cloud _Desktop_ client with the Gmail API on). With no pool configured, behavior is the classic single OneShot identity.

### Deliverability

- **Bounces.** Delivery status notifications are harvested from connected Gmail mailboxes on a 30-minute sweep, parsed per RFC 3464, and classified hard / block / soft. A hard bounce stops the cadence and suppresses the address at both draft and send time; a `5.7.x` policy block never suppresses, being a verdict on the message rather than the mailbox. `doctor` reports a per-identity rate — warn above 2%, fail above 5%, 20-send minimum. Gmail-only for now.
- **Inbox placement.** `gmail placement` sends one real message between two authorized mailboxes and reads back where the receiving account filed it, plus the SPF/DKIM/DMARC verdicts that server recorded — a verdict on the real send path, needing no DNS tooling. It's never run automatically, since repeated canaries train the seed mailbox's filter.

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

**Server** — single-user, local-first, binds `127.0.0.1` only, no auth.

```
apps/
  cli/        47-command CLI (commander); src/demo/ seeds the demo install, src/main.ts picks the workspace
  server/     Bun.serve + SSE; tsdown bundle published as `oneshot-gtm-server`
  web/        Vite + React 19 + TanStack + Base UI — 9 pages, run form, strategist dock, privacy mode
packages/
  core/       SDK wrapper, SQLite ledger, config + secrets, Gmail transport, JSONL events
  intel/      LLM client, advise, personalize, triage, weekly-review
  plays/      14 outreach plays + handoff/icp/pmf modules + cadence engine
  find/       10 finders + shared pipeline (manifest scan, dedupe, ICP filter, drain, registry)
  prompts/    Markdown prompts — humanizer canon, per-play, per-extract
  doctor/     Wallet, ledger, key and deliverability health checks
  shared-types/  Wire types shared across CLI / server / web
examples/     Sample target files for nine plays
launch/       Draft launch posts (unpublished)
docs/         The built-with badge
```

### Stack

Bun 1.3+ · Turborepo with a Bun catalog · Vitest 4 · oxlint + oxfmt · TypeScript 6 (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noImplicitOverride`) · Vite 8 + React 19 + TanStack Router/Query + Base UI + Tailwind 4 · tsdown for the server bundle · `bun:sqlite` · BYO LLM via OpenRouter, OpenAI or Anthropic.

Plain `async`/`await` throughout — no monadic abstractions to learn before reading the code. Keeps it forkable.

---

## Development

```bash
bun install
bun run typecheck                  # tsc --noEmit across cli + server + packages
bun run lint                       # oxlint
bun run fmt                        # oxfmt --write   (fmt:check in CI)
bun run test                       # vitest — 1621 cases across 126 files
bun run cli -- doctor              # smoke check
```

The web app typechecks separately, because TanStack's file-based route tree needs a build step first:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web build       # → apps/web/dist/
bun run --cwd apps/server build    # → apps/server/dist/bin.mjs + dist/web/
```

Tests set `ONESHOT_GTM_HOME` to a temp dir, so they never touch your real ledger. CI runs `bun --bun run test` — the flag matters, since `bun:sqlite` doesn't exist under Node.

### Watching what's happening

Every install writes a structured event log to `~/.oneshot-gtm/events.jsonl` — one line per LLM call, ICP decision, finder lifecycle event and swallowed `catch`. Local-only, never transmitted.

```bash
tail -f ~/.oneshot-gtm/events.jsonl | jq -c '{t:.ts, k:.kind, ctx:.ctx}'          # condensed
tail -f ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind|startswith("llm."))'    # LLM calls
tail -f ~/.oneshot-gtm/events.jsonl | jq -c 'select(.kind=="icp.decision")'       # why rejects happened
tail -f ~/.oneshot-gtm/events.jsonl | jq -c 'select(.level=="error" or .level=="warn")'
tail -2000 ~/.oneshot-gtm/events.jsonl | jq -c 'select(.run_id=="PASTE-HERE")'    # one run
DEBUG=oneshot:* oneshot-gtm find watch --once                                     # mirror to stderr
```

The `ctx` payload is bound by a strict privacy boundary — primitives, counters, durations and hostnames only.

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

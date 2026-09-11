# Finders and the ICP gates

Finders discover prospects, ICP-filter them, and enqueue into `/queue` for one-click approve or reject. Each runs as a trigger with its own interval and spend cap. The finder table is in the [README](../README.md#where-targets-come-from); this page is what happens to a candidate after a finder sees it.

## Readiness

Only `show-hn` and `post-funding-auto` are on by default; enable the rest from `/queue`. A trigger missing required config reads as **not ready** — the toggle and Run button disable with the reason, and the API returns `409`, so scripted callers can't bypass the gate either.

## Prescreen, before any spend

Before any paid `findEmail`, a prescreen skips dud domains (`*.vercel.app`, social hosts, link aggregators, personal email providers) and inputs whose "name" is obviously a username. LinkedIn URLs are captured on every finder path and verified to belong to the person before they're stored.

## Two ICP gates per candidate

The **topic gate** judges the source — the repo, event, or announcement — and keeps whole categories of noise out before any spend.

The **person gate** judges the human's role, staged by cost: free role text the finder already holds (an event bio, an extracted title), then the job title off the enrichment every verified email already pays for, then — only when still ambiguous and a LinkedIn URL exists — one extra ~$0.005 lookup. It judges capability to build and self-adopt, not job-title seniority: students shipping hackathon projects and consultants building agent systems for clients pass; a Marketing Manager at a brilliant AI company doesn't. Only a _positive_ reject drops a candidate — ambiguity escalates or proceeds, never silently discards. Rejections land in `/queue` as auditable `auto: role — <reason>` rows you can override, count as `role-drop` on trigger cards, and a prospect judged off-ICP after contact stops receiving cadence follow-ups (terminal status `off-icp`).

## Product research

Qualified first-touch rows receive a product dossier before the trigger completes: up to two known first-party pages plus quick external research covering the product, ecosystem, architecture, and business model. Set `productResearch: false` on a trigger to disable it. Research counts toward that trigger's `maxCostUsd`; a failure or exhausted cap leaves the row reviewable with an explicit warning. `find research-products` backfills the same context onto active/replied prospects and pending queue rows (`--dry-run`, `--limit`, and `--refresh` are supported). Use `--first-party-only` for a resilient bulk backfill when the external research provider is unavailable.

## Person research

The finder's title and company are whatever the source showed: a guest-list slogan, a headline, an enrichment that may be a year stale. After a finder run, each new row with a researchable profile (LinkedIn, X, GitHub; else an email plus a name) gets one `deepResearchPerson` call from that profile and one `enrichCompany` lookup for the employer it names as current — about $0.055 per row, minutes per call, so it runs after the finder and never behind a click. The record (`personResearch`: current role with its start date, the organisation history, bio, company facts) lands on the queue payload before a prospect exists and moves into `prospects.dossier_json` at send; the row's `title` and `company` are corrected to the current ones with the finder's originals kept (`titleAtFinder`, `companyAtFinder`). Every consumer reads the same record: the draft's DOSSIER block, angle selection, rotate-angle, and the reject box's prefill. Cross-workspace cache, 90 days, so a person researched for one product is never bought again for another.

It is on for every trigger; set `personResearch: false` on a trigger to disable it. Research counts toward that trigger's `maxCostUsd`. Rows drafted before the research landed keep their draft and show a `researched · regenerate to use it` badge.

The person gate is re-judged on the researched role when its verdict was missing or `unclear`, or when the role changed. A `reject` on a **pending** row rejects it exactly as the finder would have (`auto: role — <reason>`, auditable, overridable). An **approved** row is never auto-rejected: the verdict is stamped with a note and the step-0 off-ICP gate holds the send with the reason visible. A **prospect in cadence** judged off-ICP stops receiving follow-ups; the verdict is on `/prospects` and editable. A verified address at a company the history says has ended is flagged `email-at-former-employer` — a soft flag, so **Send anyway** still works; the address is never swapped for the researched one.

**Live LinkedIn reads.** The provider's history can trail a person's live profile by months. Paste your own `li_at` cookie on `/setup` (dev tools → Application → Cookies → linkedin.com) and connect it once: a one-time browser task sets the cookie inside a persistent OneShot browser profile, and from then on person research also reads the profile page's Experience section as a cheap browser task in that profile (about $0.02 a row, with a receipt) and lets it win over the provider's history for every company the page lists. Reads run as your LinkedIn account: they show up as profile views, they are serialized fifteen seconds apart, and they stop at `linkedinReadsPerDay` (default 80) per day; a login wall marks the session invalid, `doctor` says so, and `/setup` asks for a fresh cookie. Set `linkedinProfileRead: false` on a trigger to leave it on provider history, or pass `--no-live` to a backfill. Rows already researched are not re-read until `--refresh`.

Backfill, in this order per workspace: `find research-queue --status live` (pending and approved rows), `find research-prospects --scope all --refresh` (every prospect with a profile URL: sent, in cadence, completed, replied), then `find synthesize-angles --refresh --scope active` so follow-ups and reply drafts pick up the new dossier. None of the three has a cost cap by default (`--max-cost-usd` bounds a rehearsal); each run considers up to 100,000 rows per status and researched rows are skipped, so re-running continues where the last run stopped. `--dry-run` shows counts and an estimate; `--no-rejudge` and `--no-company` narrow what is bought.

## Review order

The pending review list on `/queue` can be ordered `newest` or `ranked` (finder-interleaved priority score with exploration slots). It's a toggle on the page, defaulted by `queueReviewOrder` in config. `find calibrate` measures the score against logged outcomes (shadow only; scores drive nothing but this ordering until they clear the acceptance bar).

## Draining

Approved rows ship via the **Drain** button or `find drain <play>`. Both respect the daily [spend ceiling](./background-monitoring.md#spend-ceiling) and the per-identity send caps.

## Finder-specific keys

- `GITHUB_TOKEN` — without it the two GitHub finders share GitHub's unauthenticated ceiling of 60 requests/hour per IP and halt on a `403`. A classic token with **no scopes** is enough. `doctor` warns when it's missing and a GitHub finder is on.
- `x-reposters` — four OAuth1 values for the first-party X API, or `TWITTERAPI_IO_KEY` for the ~55x cheaper third-party engine. Pick the provider on `/setup` or with `config x-engine`.
- `LUMA_SESSION_COOKIE` — optional; only buys authed Luma guest lists.

All of these are env-only: `init` never asks, but `/setup` and `config keys` store them in the workspace's `.env`.

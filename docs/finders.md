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

## Review order

The pending review list on `/queue` can be ordered `newest` or `ranked` (finder-interleaved priority score with exploration slots). It's a toggle on the page, defaulted by `queueReviewOrder` in config. `find calibrate` measures the score against logged outcomes (shadow only; scores drive nothing but this ordering until they clear the acceptance bar).

## Draining

Approved rows ship via the **Drain** button or `find drain <play>`. Both respect the daily [spend ceiling](./background-monitoring.md#spend-ceiling) and the per-identity send caps.

## Finder-specific keys

- `GITHUB_TOKEN` — without it the two GitHub finders share GitHub's unauthenticated ceiling of 60 requests/hour per IP and halt on a `403`. A classic token with **no scopes** is enough. `doctor` warns when it's missing and a GitHub finder is on.
- `x-reposters` — four OAuth1 values for the first-party X API, or `TWITTERAPI_IO_KEY` for the ~55x cheaper third-party engine. Pick the provider on `/setup` or with `config x-engine`.
- `SAM_GOV_API_KEY` — `gov-solicitation`.
- `LUMA_SESSION_COOKIE` — optional; only buys authed Luma guest lists.

All of these are env-only: `init` never asks, but `/setup` and `config keys` store them in the workspace's `.env`.

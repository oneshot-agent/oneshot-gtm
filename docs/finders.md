# Finders and the ICP gates

Finders discover prospects, ICP-filter them, and enqueue into `/queue` for one-click approve or reject. Each runs as a trigger with its own interval and spend cap. The finder table is in the [README](../README.md#where-targets-come-from); this page is what happens to a candidate after a finder sees it.

## Readiness

All finders start disabled in a new workspace. Enable relevant sources from `/queue` or apply an industry pack. Existing workspaces retain their saved enablement. A trigger missing required config reads as **not ready** — the toggle and Run button disable with the reason, and the API returns `409`, so scripted callers can't bypass the gate either.

## Prescreen, before any spend

Before any paid `findEmail`, a prescreen skips dud domains (`*.vercel.app`, social hosts, link aggregators, personal email providers) and inputs whose "name" is obviously a username. LinkedIn URLs are captured on every finder path and verified to belong to the person before they're stored.

## Two ICP gates per candidate

The **topic gate** judges the source — the repo, event, or announcement — and keeps whole categories of noise out before any spend.

The **person gate** judges the human's role, staged by cost: free role text the finder already holds (an event bio, an extracted title), then the job title off the enrichment every verified email already pays for, then — only when still ambiguous and a LinkedIn URL exists — one extra ~$0.005 lookup. What qualifies comes from your ICP one-liner in config, not from the prompt: the same title flips with the definition, so an ICP that says capability matters more than seniority passes a student shipping real projects and rejects a marketing manager, while an ICP about owners who run customer acquisition passes a head of growth and rejects a backend engineer. The shared prompts carry no assumptions about your product, your buying process or your industry. Only a _positive_ reject drops a candidate — ambiguity escalates or proceeds, never silently discards. Rejections land in `/queue` as auditable `auto: role — <reason>` rows you can override, count as `role-drop` on trigger cards, and a prospect judged off-ICP after contact stops receiving cadence follow-ups (terminal status `off-icp`).

## Product research

Qualified first-touch rows receive a product dossier before the trigger completes: up to two known first-party pages plus quick external research covering the product, ecosystem, architecture, and business model. Set `productResearch: false` on a trigger to disable it. Research counts toward that trigger's `maxCostUsd`; a failure or exhausted cap leaves the row reviewable with an explicit warning. `find research-products` backfills the same context onto active/replied prospects and pending queue rows (`--dry-run`, `--limit`, and `--refresh` are supported). Use `--first-party-only` for a resilient bulk backfill when the external research provider is unavailable.

## Person research

The finder's title and company are whatever the source showed: a guest-list slogan, a headline, an enrichment that may be a year stale. After a finder run, each new row with a researchable profile (LinkedIn, X, GitHub; else an email plus a name) gets one `deepResearchPerson` call from that profile and one `enrichCompany` lookup for the employer it names as current — about $0.055 per row, minutes per call, so it runs after the finder and never behind a click. The record (`personResearch`: current role with its start date, the organisation history, bio, company facts) lands on the queue payload before a prospect exists and moves into `prospects.dossier_json` at send; the row's `title` and `company` are corrected to the current ones with the finder's originals kept (`titleAtFinder`, `companyAtFinder`). Every consumer reads the same record: the draft's DOSSIER block, angle selection, rotate-angle, and the reject box's prefill. Cross-workspace cache, 90 days, so a person researched for one product is never bought again for another.

It is on for every trigger; set `personResearch: false` on a trigger to disable it. Research counts toward that trigger's `maxCostUsd`. Rows drafted before the research landed keep their draft and show a `researched · regenerate to use it` badge.

The person gate is re-judged on the researched role when its verdict was missing or `unclear`, or when the role changed. A `reject` on a **pending** row rejects it exactly as the finder would have (`auto: role — <reason>`, auditable, overridable). An **approved** row is never auto-rejected: the verdict is stamped with a note and the step-0 off-ICP gate holds the send with the reason visible. A **prospect in cadence** judged off-ICP stops receiving follow-ups; the verdict is on `/prospects` and editable. A verified address at a company the history says has ended is flagged `email-at-former-employer` — a soft flag, so **Send anyway** still works; the address is never swapped for the researched one.

**Live LinkedIn reads.** This browser connection is for profile research; [OneShot LinkedIn messaging](./linkedin.md) uses a separate connected account. The provider's history can trail a person's live profile by months. Connect LinkedIn once on `/setup`: **Connect LinkedIn** opens a hosted browser tab where you sign in as yourself (2FA included, $0.30 platform allowance per sign-in); come back and click **Done** and the session is saved into a persistent OneShot browser profile. The sign-in happens on a pending profile and replaces the working one only once its feed verifies, so a Done click before you finished signing in, or after the tab was closed, changes nothing — the card says "not signed in yet" and you can click Done again or cancel. Behind **advanced: use a cookie**, paste your `li_at` (dev tools → Application → Cookies → linkedin.com) and connect with it instead; it is imported into a fresh profile without any credential passing through a task. From then on person research also reads the profile page's Experience section as a cheap browser task in that profile (about $0.02 a row, with a receipt) and lets it win over the provider's history for every company the page lists. Reads run as your LinkedIn account: they show up as profile views, they are serialized fifteen seconds apart, and they stop at `linkedinReadsPerDay` (default 80) per day; a login wall marks the session invalid, `doctor` says so, and `/setup` asks you to reconnect. `oneshot-gtm config linkedin-session` does the same from the terminal. The post-finder pass reads what fits in its wall budget (about four rows); the server's scheduler sweeps the rest a few times a day — live queue rows with a LinkedIn profile and no live read yet, approved first — under the same daily cap, so a busy finder run does not leave rows on provider history. Set `linkedinProfileRead: false` on a trigger to leave it on provider history, or pass `--no-live` to a backfill. Rows already researched are not re-read until `--refresh`.

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

## Expired queue rows

Expired is a queue status, not deletion. Queue and Prospects allow a human to approve an expired row again; approval makes it eligible for drafting and a later send. Review whether its original signal is still relevant. A prospect who has already replied cannot be re-approved for cold outreach, and sent rows cannot be approved again.

Re-engagement (`breakup-revive`) rows expire when the prospect replies or their cadence is stopped. An age-based expiry helper exists, but no production scheduler currently invokes it, so there is no automatic “expires after N days” policy. CSV imports temporarily reserve rows as expired during ICP classification; those rows cannot be approved until classification finishes.

## Incomplete targets after an override

An early ICP rejection may be saved before contact lookup, so approving that row does not mean it already has an email. Run forms load the source trigger's current `yourEdge` / `yourClaim` without rewriting the historical queue payload.

For approved GitHub Stars rows without an email, **Find missing emails** on the Run page resumes contact lookup using the original GitHub identity and verifies the result. It can incur lookup charges, reloads the form (replacing unsaved edits), and never sends. Failed lookups remain incomplete; enter a verified email manually or leave that row out. Simply listing or approving a row performs no paid contact lookup.

Contact lookup retries reuse completed receipts from the current workspace for
14 days. Email discovery matches both the full name and domain; verification
matches the exact email address (case-insensitive). Successful results and
completed negative results are reused without additional lookup charges.
Transport errors are not cached as negative results. A public GitHub profile
email bypasses email discovery and goes straight to verification. GitHub role
rejections retain an email already verified earlier in the same run.

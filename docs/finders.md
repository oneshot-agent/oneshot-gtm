# Finders and the ICP gates

Finders discover prospects, ICP-filter them, and enqueue into `/queue` for one-click approve or reject. Each runs as a trigger with its own interval and spend cap. The finder table is in the [README](../README.md#where-targets-come-from); this page is what happens to a candidate after a finder sees it.

## Readiness

All finders start disabled in a new workspace. Enable relevant sources from `/queue` or apply an industry pack. Existing workspaces retain their saved enablement. A trigger missing required config reads as **not ready** — the toggle and Run button disable with the reason, and the API returns `409`, so scripted callers can't bypass the gate either.

## Prescreen, before any spend

Before any paid `findEmail`, a prescreen skips dud domains (`*.vercel.app`, social hosts, link aggregators, personal email providers) and inputs whose "name" is obviously a username. When contact lookup captures a LinkedIn URL, it verifies that the profile belongs to the person before storing it.

## Contact qualification

Contact-based finders use topic and person gates. Community threads use the relevance and buying-intent checks [below](#community-buying-requests).

The **topic gate** judges the source — the repo, event, or announcement — and keeps whole categories of noise out before any spend.

The **person gate** judges the human's role, staged by cost: free role text the finder already holds (an event bio, an extracted title), then the job title off the enrichment every verified email already pays for, then — only when still ambiguous and a LinkedIn URL exists — one extra ~$0.005 lookup. What qualifies comes from your ICP one-liner in config, not from the prompt: the same title flips with the definition, so an ICP that says capability matters more than seniority passes a student shipping real projects and rejects a marketing manager, while an ICP about owners who run customer acquisition passes a head of growth and rejects a backend engineer. The shared prompts carry no assumptions about your product, your buying process or your industry. Only a _positive_ reject drops a candidate — ambiguity escalates or proceeds, never silently discards. Rejections land in `/queue` as auditable `auto: role — <reason>` rows you can override, count as `role-drop` on trigger cards, and a prospect judged off-ICP after contact stops receiving cadence follow-ups (terminal status `off-icp`).

## Channels

Contact-based finders queue people on `email`, `linkedin` or `x`. The `channels` setting lists the ones you want, in order of preference. The first channel a person has an address on wins:

- `["email"]` (the default): today's behaviour. Anyone without a deliverable email is dropped.
- `["email", "linkedin"]`: email when one is found. Otherwise the person is queued on LinkedIn, using the profile the finder already has or one search by name and company, instead of being dropped.
- `["linkedin"]` or `["linkedin", "email"]`: LinkedIn first. No email lookup is paid for when a profile is found.

Set it for the whole workspace in `config.json` (`"channels": [...]`) or per trigger in its config. The trigger's setting wins. The person gate applies on every channel. A LinkedIn row goes out as a connection request with a note; see [LinkedIn](./linkedin.md#connection-requests-as-a-first-touch). X is sent by hand: an X row gets a DM (280 characters at most) drafted from its signal. Copy it, send it from X, then **Mark sent**, because OneShot has no X action API yet. The contact step never searches X; a person is queued on X only when the finder already has their handle (Luma lists attendees' X profiles).

Community replies stay on their source platform (`reddit` or `hacker-news`) and are posted manually.

## Product research

Qualified first-touch rows receive a product dossier before the trigger completes: up to two known first-party pages plus quick external research covering the product, ecosystem, architecture, and business model. Set `productResearch: false` on a trigger to disable it. Research counts toward that trigger's `maxCostUsd`; a failure or exhausted cap leaves the row reviewable with an explicit warning. `find research-products` backfills the same context onto active/replied prospects and pending queue rows (`--dry-run`, `--limit`, and `--refresh` are supported). Use `--first-party-only` for a resilient bulk backfill when the external research provider is unavailable.

## Person research

The finder's title and company are whatever the source showed: a guest-list slogan, a headline, an enrichment that may be a year stale. After a finder run, each new row with a researchable profile (LinkedIn, X, GitHub; else an email plus a name) gets one `deepResearchPerson` call from that profile and one `enrichCompany` lookup for the employer it names as current — about $0.055 per row, minutes per call, so it runs after the finder and never behind a click. The record (`personResearch`: current role with its start date, the organisation history, bio, company facts) lands on the queue payload before a prospect exists and moves into `prospects.dossier_json` at send; the row's `title` and `company` are corrected to the current ones with the finder's originals kept (`titleAtFinder`, `companyAtFinder`). Every consumer reads the same record: the draft's DOSSIER block, angle selection, rotate-angle, and the reject box's prefill. Cross-workspace cache, 90 days, so a person researched for one product is never bought again for another.

It is on for every trigger; set `personResearch: false` on a trigger to disable it. Research counts toward that trigger's `maxCostUsd`. Rows drafted before the research landed keep their draft and show a `researched · regenerate to use it` badge.

The person gate is re-judged on the researched role when its verdict was missing or `unclear`, or when the role changed. A `reject` on a **pending** row rejects it exactly as the finder would have (`auto: role — <reason>`, auditable, overridable). An **approved** row is never auto-rejected: the verdict is stamped with a note and the step-0 off-ICP gate holds the send with the reason visible. A **prospect in cadence** judged off-ICP stops receiving follow-ups; the verdict is on `/prospects` and editable. A verified address at a company the history says has ended is flagged `email-at-former-employer` — a soft flag, so **Send anyway** still works; the address is never swapped for the researched one.

**Live LinkedIn reads.** This browser connection is for profile research; [OneShot LinkedIn messaging](./linkedin.md) is a separate connected account, and the one **Connect LinkedIn** button on `/setup` runs both sign-ins back to back: the messaging account first (once, shared by every workspace, confirmed by OneShot on its own), then the profile session (per workspace) in the same tab. The provider's history can trail a person's live profile by months. The profile session is a hosted browser tab where you sign in as yourself (2FA included, $0.30 platform allowance per sign-in); come back and click **Done** and the session is saved into a persistent OneShot browser profile. The sign-in happens on a pending profile and replaces the working one only once its feed verifies, so a Done click before you finished signing in, or after the tab was closed, changes nothing — the card says "not signed in yet" and you can click Done again or cancel. Behind **advanced: use a cookie**, paste your `li_at` (dev tools → Application → Cookies → linkedin.com) and connect with it instead; it is imported into a fresh profile without any credential passing through a task. From then on person research also reads the profile page's Experience section as a cheap browser task in that profile (about $0.02 a row, with a receipt) and lets it win over the provider's history for every company the page lists. Reads run as your LinkedIn account: they show up as profile views, they are serialized fifteen seconds apart, and they stop at `linkedinReadsPerDay` (default 80) per day; a login wall marks the session invalid, `doctor` says so, and `/setup` asks you to reconnect. `oneshot-gtm config linkedin-session` does the same from the terminal. The post-finder pass reads what fits in its wall budget (about four rows); the server's scheduler sweeps the rest a few times a day — live queue rows with a LinkedIn profile and no live read yet, approved first — under the same daily cap, so a busy finder run does not leave rows on provider history. Set `linkedinProfileRead: false` on a trigger to leave it on provider history, or pass `--no-live` to a backfill. Rows already researched are not re-read until `--refresh`.

Backfill, in this order per workspace: `find research-queue --status live` (pending and approved rows), `find research-prospects --scope all --refresh` (every prospect with a profile URL: sent, in cadence, completed, replied), then `find synthesize-angles --refresh --scope active` so follow-ups and reply drafts pick up the new dossier. None of the three has a cost cap by default (`--max-cost-usd` bounds a rehearsal); each run considers up to 100,000 rows per status and researched rows are skipped, so re-running continues where the last run stopped. `--dry-run` shows counts and an estimate; `--no-rejudge` and `--no-company` narrow what is bought. `--cache-only --refresh` re-derives every row from research already bought (the 90-day shared cache) and bills nothing; rows with nothing cached are left alone. Research also keeps the provider's LinkedIn profile URL and fills it onto a row or prospect that has none — never over one a finder set. Recent posts are captured when a row is approved (in the background; approving never waits) and, every few hours, for prospects in a running cadence whose cached posts are missing or older than 14 days — never for the pending rows a finder creates, since most are rejected. Each capture is about $0.07 from a LinkedIn or X profile, one call at a time, cached 14 days across workspaces, under the daily spend ceiling; the dossier keeps only a pointer and nothing drafts from the posts yet. Set `personNewsfeed: false` on a trigger to skip it for that trigger's rows, or pass `--no-newsfeed` on a research run; `--newsfeed-only` captures posts for rows that already carry research, with `--dry-run` showing the count and estimate, and `--cache-only` never buys one.

**GitHub-only people.** For someone whose whole public footprint is GitHub, the github-stars gate judges on what GitHub publishes, since person research usually comes back `unavailable`: bio, company, site, location, account age, their own recent repos, and a profile-README excerpt on a bare profile (one extra API call per candidate, up to three on bare profiles). The block is stored on the row as `githubEvidence`. `find rejudge-github` re-runs that decision on live github-stars rows with no paid research: pending rejects move to rejected, approved rows only with `--reject-approved`, and a GitHub or classifier failure skips a row rather than rejecting it. `--dry-run` writes nothing.

**Rows moved from another workspace.** A move (the row's **move →** menu) carries the person and their research across, but not the sending workspace's edge, ICP verdict or fit line: those were written for the other product. On arrival the receiving workspace re-derives them for itself. The edge comes from its own trigger for that play (the trigger the row's source names, else one routed to the same play). If none has an edge, it writes one from the workspace's product positioning and the row's research, marked as generated. The verdict comes from re-judging the carried research against this ICP. A row that doesn't fit stays pending with the reason shown, because you moved it on purpose. This runs in the background and costs at most two small model calls. `find rederive --id <n>` or `find rederive --moved` does the same for rows moved before this existed, or whose background run timed out. `--dry-run` prints without writing, and status never changes.

## Review order

The pending review list on `/queue` can be ordered `newest` or `ranked` (finder-interleaved priority score with exploration slots). It's a toggle on the page, defaulted by `queueReviewOrder` in config. `find calibrate` measures the score against logged outcomes (shadow only; scores drive nothing but this ordering until they clear the acceptance bar).

## Draining

Approved rows ship via the **Drain** button or `find drain <play>`. Both respect the daily [spend ceiling](./background-monitoring.md#spend-ceiling) and the per-identity send caps.

## Finder-specific keys

- `GITHUB_TOKEN` — without it the two GitHub finders share GitHub's unauthenticated ceiling of 60 requests/hour per IP and halt on a `403`. A classic token with **no scopes** is enough. `doctor` warns when it's missing and a GitHub finder is on.
- `x-reposters` — four OAuth1 values for the first-party X API, or `TWITTERAPI_IO_KEY` for the ~55x cheaper third-party engine. Pick the provider on `/setup` or with `config x-engine`.
- `LUMA_SESSION_COOKIE` — optional; only buys authed Luma guest lists.

All of these are env-only: `init` never asks, but `/setup` and `config keys` store them in the workspace's `.env`.

## Institutional buyers

Set `play: "design-partner-loi"` and `buyerType` (`enterprise`, `government` or `hardware`) on a finder's trigger to send its rows to the design-partner play instead of the finder's own founder-to-founder play. That play writes for an institutional evaluator: the first email opens on their company and asks whether they own the problem, the second offers a design-partner conversation, and the last proposes one scoped pilot and closes. It works on hiring-signal, job-change, post-funding, podcast-guest, local-business and list-page (which routes only there). The trigger is ready only with an edge and a valid buyer type, and dedupe covers both plays, so switching the setting never lets the same person through twice.

## List pages

`list-page` turns any public page that lists companies into a source: an open-source project's `ADOPTERS` file, a conference sponsor page, a vendor's customers page. Each entry in `sources` is `{url, signal}`, where `signal` says in a few words what being on the list means, for example `runs Backstage`.

- A GitHub file link (`/blob/`), a raw GitHub link or a data file (`.json`, `.yml`, `.md`, `.txt`) is fetched directly for free, with two retries if the network fails; any other page costs one web read. The companies are extracted once per version of the page and cached, so an unchanged list costs nothing to re-read.
- Companies are worked `limit` per run, one from each list in turn, skipping any already queued. A company two lists name is worked once, under the first. For each, the finder finds the company's decision owner from its domain (people search, the person gate, then email). When the page gives no website, one company search looks the domain up by name. Set `jobTitles` (the roles you sell to, most wanted first) to make that a title-scoped people search: up to three matches are tried in your order. A person counts as a match only when their title carries every word of a wanted title as whole words (`VP of AI` matches `Vice President, Artificial Intelligence`; `CTO` does not match `Director`). A company with no one matching is left alone for 30 days, then looked at again, or at once when you change `jobTitles`. It is not rejected. Without it the pick is any senior title at the domain, which at a large company can be someone in PR or recruiting.
- People the page names, often the engineers who set the tool up, are kept on the row as context and never emailed.
- Every row carries the signal and the page's own line about that company. An angle in `yourEdge` can open on it (_For a company that runs Backstage —_), and the design-partner email may use it as its hook, stated as the public fact it is.
- For now it routes only to `design-partner-loi`, so it needs `play`, `buyerType` and `yourEdge` to be ready.

### Checking a list someone else compiled

An `ADOPTERS` file is a company vouching for itself. A blog roundup, an aggregator or a vendor's marketing page is someone else saying so. Give a source like that `verify: {names, via}`, and each company's own evidence is checked before any paid contact step. `names` is the vendor or tool plus its aliases. Names match as whole words, ignoring case.

- `via: ["subprocessors"]` (the default) is for hosted vendors that touch customer data, such as an LLM API or a browser cloud.
  1. Free: the company's subprocessor list is fetched from the usual paths (`/subprocessors`, `/legal/sub-processors`, `trust.<domain>` and similar).
  2. Paid: when none of those works, one web search finds the page, and one web read renders it if it is built by script.
  3. A list that names the vendor confirms it. A real list that leaves the vendor out drops the company, recorded once so later runs skip it. A page only counts as a list when it also names the processors such lists always carry (AWS, Datadog and the like), so a trust centre that loads its list by script is never read as "absent".
- `via: ["mentions"]` is for self-hosted tools. Backstage never appears on a subprocessor list, so never use `subprocessors` for one. The company's own site and its job posts are searched for the tool. A hit on its own site must also carry engineering context, because tool names are often ordinary words. This check can only confirm.
- No evidence either way keeps the row, marked unconfirmed. The queue shows `uses X (unconfirmed)` or `uses X ✓`, and the email writer is told not to state an unconfirmed signal as fact about the company.
- A result is cached per domain for 30 days, except one left by a failed call, which is checked again on the next run.

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

GitHub Stars and GitHub Topics use a personal-profile README as the final email
fallback. Public profile email comes first, then existing contact lookup stages
(including enabled topic enrichment/research), then the individual's public
`username/username` README. An undeliverable address can fall through; duplicates,
qualification rejections and temporary service errors do not trigger another search.

README extraction accepts explicit personal contact text or contact-labelled email
links, skips unrelated/example/team addresses, and leaves ambiguous results unresolved.
Extracted addresses are verified using the same 14-day receipt history. The queue
retains the README source URL and resolution timestamp. Completed README extraction
results are cached in memory for 24 hours; temporary errors are not cached as misses.
Requests are bounded to 10 seconds and 64 KiB. The existing approved-row recovery
action gains this fallback; deployment does not retry historical rows or send messages.

## Community buying requests

Enable `community-buyer-threads` in Queue's finder controls. It uses the normal Run now, schedule, review and draft flow; new workspaces start with it disabled.

Set `keywords` (category phrases) and/or `competitors` (product names), up to 20 terms total. Defaults:

- `platforms`: `["reddit", "hacker-news"]`
- `sinceDays`: `7`; `limit`: `25`; `maxCostUsd`: `5`
- Polling: every six hours

HN search needs no Algolia key. Reddit uses existing OneShot search/read credentials. Coverage depends on indexing. Source failures appear separately from empty results and can be retried.

Rows retain the opening post's URL, author, date, text and classification evidence. Relevant and uncertain matches await review; unrelated posts are saved as rejected. Repeated discoveries of a thread are deduplicated. Product and person research default off; no email lookup is required.

Approve a row, then generate its draft or run `oneshot-gtm find drain community-reply`. Setup must contain your founder name, product description and verified product brief. Drafts use that brief and disclose your affiliation; review claims before posting.

Use **Open thread**, **Copy reply**, then **Mark posted** after posting yourself. Confirmation records the action once. Nothing posts automatically or starts an email cadence; later drains retain clean drafts.

Finder caps and daily reservations apply. OneShot calls retain their receipts. LLM calls record provider costs when available, otherwise a labeled $0.05-per-call estimate, including attempted calls with uncertain failure costs. Caps check estimates before calls and reported costs afterward, so actual charges can exceed an estimate. Manual posting creates no paid receipt.

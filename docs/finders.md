# Finders and the ICP gates

A finder does not find customers. It finds candidates, and a gate throws most of them away. What survives lands in the queue with its evidence, for you to approve or reject.

Each finder is a trigger with its own schedule and spend cap. All of them start off.

| Finder                    | Signal                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `show-hn`                 | same-day Show HN posts                                                                           |
| `post-funding-auto`       | funding announcements, by industry and round                                                     |
| `accelerator-batch`       | new cohorts: Y Combinator, SPC, Neo, Antler, Techstars, 500 Global, AI Grant, HF0, a16z Speedrun |
| `job-change`              | "joined as" announcements, by persona and company                                                |
| `hiring-signal`           | open roles on Greenhouse, Lever, Workable and Ashby that imply a need                            |
| `podcast-guest`           | recent guests on shows you name                                                                  |
| `github-topics`           | repos by topic, with the vendor stack read from their manifests (needs `GITHUB_TOKEN`)           |
| `github-stars`            | recent stargazers of repos you watch, each tagged competitor or adjacent (needs `GITHUB_TOKEN`)  |
| `luma-events`             | hosts and featured guests of upcoming Luma events that match your topics                         |
| `x-reposters`             | people who repost or quote X accounts you watch (needs X API keys)                               |
| `local-business`          | main-street businesses by title, industry, location and size                                     |
| `local-registry`          | newly licensed businesses from public registries: business licences, NPPES, FMCSA                |
| `gov-solicitation`        | SAM.gov Sources Sought and Presolicitation notices by NAICS code                                 |
| `civic-agenda`            | city and county council agenda items                                                             |
| `list-page`               | companies on any public list: an ADOPTERS file, a sponsor page, a customers page                 |
| `community-buyer-threads` | Reddit and Hacker News posts asking for a recommendation or a replacement                        |
| `breakup-revive`          | your own ledger: prospects cold for 60 to 90 days. No paid calls                                 |

## Readiness

Enable a finder from **Queue**, or apply an industry pack. A trigger missing required config reads **not ready**: the toggle and Run button are disabled with the reason, and the API answers `409`.

A finder you keep rejecting pauses itself. When fewer than 10% of its reviewed rows were approved over 30 days, with at least 100 reviewed, scheduled runs skip it. `find watch --ignore-approval-rate` runs it anyway.

## The gates

Three checks, cheapest first. Only a positive reject drops a candidate; an unclear answer moves on.

1. **Prescreen, free.** Skips dud domains (`*.vercel.app`, social hosts, personal email providers) and names that are plainly usernames.
2. **Topic gate, before any spend.** Judges the source: the repo, the event, the announcement.
3. **Person gate.** Judges the human's role against your ICP one-liner. It reads the role text the finder already holds, then the title that comes with a verified email, then one extra lookup if it is still unclear.

What qualifies comes from your ICP, not from the prompt. An ICP about owners who run customer acquisition passes a head of growth and rejects a backend engineer. Change the ICP and the same title flips.

A rejection is a queue row marked `auto: role` with its reason. You can override it. A prospect judged off-ICP after contact stops receiving follow-ups.

Set `personGate: "affinity"` on a trigger whose topic is what you sell. Showing up then counts as fit, whatever the title.

## Channels

`channels` lists where a person may be reached, in order of preference. The first one they have an address on wins.

- `["email"]`, the default. No deliverable email, no row.
- `["email", "linkedin"]`. Email when one is found, otherwise LinkedIn.
- `["linkedin"]` or `["linkedin", "email"]`. LinkedIn first; no email lookup is paid when a profile is found.

Set it in `config.json` for the workspace or on one trigger. The trigger wins. A LinkedIn row goes out as a [connection request with a note](./linkedin.md#connection-requests-as-a-first-touch). `linkedinContinuation` makes an email cadence [carry on to LinkedIn](./linkedin.md#continuing-an-email-cadence-on-linkedin).

X is sent by hand: the row gets a DM draft of at most 280 characters. Copy it, send it on X, then **Mark sent**. A person is queued on X only when the finder already holds their handle.

## Research

Every qualified row is researched after the finder run, never behind a click. All of it counts toward the trigger's `maxCostUsd`. Prices are on the [pricing page](https://docs.oneshotagent.com/pricing).

| Research      | What it adds                                                              | Turn off with                |
| ------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Product       | what the company sells, from its own pages and one outside search         | `productResearch: false`     |
| Person        | current role with start date, history, bio, employer facts                | `personResearch: false`      |
| Live LinkedIn | the profile's own Experience section, read through your connected session | `linkedinProfileRead: false` |
| Recent posts  | LinkedIn or X posts, bought when you approve the row                      | `personNewsfeed: false`      |

Person research corrects the row's title and company and keeps the finder's originals. The result is cached for 90 days across workspaces, so a person is bought once. The person gate runs again on the researched role. A pending row that now fails is rejected with its reason. An approved row is never auto-rejected: the send is held and the reason is shown. A verified address at an employer the history says has ended is flagged `email-at-former-employer`; **Send anyway** still works.

### Live LinkedIn reads

A data provider's history can trail a live profile by months. **Connect LinkedIn** on Setup signs you in twice, back to back: once for [messaging](./linkedin.md), once for a hosted browser session that reads profiles as you. Where the page lists a company, the page wins over the provider.

- Reads show up as profile views from your account.
- They run 15 seconds apart and stop at `linkedinReadsPerDay` (default 80).
- A login wall marks the session invalid. `doctor` says so and Setup asks you to reconnect.
- A row whose read failed for its own reason waits three days before another try.

`config linkedin-session` does the same from the terminal. `--no-live` on a backfill skips the reads.

### Backfill

Run in this order, per workspace:

```bash
oneshot-gtm find research-queue --status live                    # pending and approved rows
oneshot-gtm find research-prospects --scope all --refresh        # everyone already contacted
oneshot-gtm find synthesize-angles --refresh --scope active      # follow-ups pick up the new dossier
```

The last two stop at 250 rows a run; pass `--limit` for more. Researched rows are skipped, so a re-run continues where the last one stopped. `--dry-run` prints counts and an estimate. `--max-cost-usd` bounds a run. `--cache-only --refresh` re-derives from research already bought and bills nothing. `find research-products` backfills product research and stops at 5 USD unless you pass `--no-cost-limit`.

### People whose footprint is GitHub

Person research usually finds nothing for them. The `github-stars` gate judges on what GitHub publishes: bio, company, site, location, account age, their own recent repos and a profile README. `find rejudge-github` re-runs that decision on live rows without paid research. Pending rejects move to rejected; approved rows move only with `--reject-approved`.

### Rows moved between workspaces

**move →** on a queue row hands the person and their research to another workspace. The edge, ICP verdict and fit line stay behind; they were written for the other product. The receiving workspace derives its own in the background. A row that does not fit stays pending with the reason shown, because you moved it on purpose. `find rederive --id <n>` or `--moved` runs the same step by hand.

## Review order and sending

The pending list sorts `newest` or `ranked`. The toggle is on the page; `queueReviewOrder` in config sets the default. Ranking only orders the list. It decides nothing else.

Approved rows go out when you press **Batch send…** or run `find drain <play>`. Both respect the [daily spend ceiling](./background-monitoring.md#spend-ceiling) and the mailbox caps.

## Finder-specific keys

- `GITHUB_TOKEN`. Without it the GitHub finders share 60 requests an hour per IP and halt on a `403`. A classic token with no scopes is enough.
- `x-reposters`. Four OAuth1 values for the X API, or `TWITTERAPI_IO_KEY` for the third-party engine. Pick one on Setup or with `config x-engine`.
- `LUMA_SESSION_COOKIE`. Optional; it only adds signed-in guest lists.

`init` never asks for these. Setup and `config keys` store them in the workspace's `.env`.

## Institutional buyers

Set `play: "design-partner-loi"` and `buyerType` (`enterprise`, `government` or `hardware`) on a trigger. Its rows then go to the design-partner play: the first email asks whether they own the problem, the second offers a design-partner conversation, the last proposes one scoped pilot. It works on `hiring-signal`, `job-change`, `post-funding`, `podcast-guest`, `local-business` and `list-page`. Dedupe covers both plays, so switching never lets the same person through twice.

## List pages

`list-page` turns any public list of companies into a source. Each entry in `sources` is `{url, signal}`, where `signal` says what being on the list means, for example `runs Backstage`. It routes only to `design-partner-loi`, so it needs `play`, `buyerType` and `yourEdge`.

- A GitHub file, a raw link or a data file is fetched free. Any other page costs one web read. An unchanged list costs nothing to read again.
- Companies are worked `limit` per run, one from each list in turn.
- Set `jobTitles`, most wanted first, to pick the owner by title. A title matches only when it carries every word of a wanted title: `VP of AI` matches `Vice President, Artificial Intelligence`; `CTO` does not match `Director`. A company with no match is left for 30 days, then tried again.
- Without `jobTitles` the pick is any senior title, which at a large company can be PR or recruiting.
- People the page names are kept as context and never emailed.

### A list someone else compiled

An `ADOPTERS` file is a company vouching for itself. A blog roundup is someone else saying so. Give that source `verify: {names, via}` and each company's own evidence is checked before any paid contact step.

- `via: ["subprocessors"]`, the default, is for hosted vendors that touch customer data. The company's subprocessor list is fetched from the usual paths. A list that names the vendor confirms it. A real list without the vendor drops the company.
- `via: ["mentions"]` is for self-hosted tools, which never appear on a subprocessor list. The company's site and job posts are searched. This check can only confirm.
- No evidence either way keeps the row, marked unconfirmed. The draft is told not to state an unconfirmed signal as fact.

## Expired and incomplete rows

Expired is a status, not a deletion. You can approve an expired row again; check that its signal still holds. A prospect who already replied cannot be re-approved for cold outreach.

Approving a row the gate rejected early does not give it an email. For approved `github-stars` rows without one, **Find missing emails** on the Run page resumes the lookup and verifies the result. It may bill, and it never sends. Contact lookups reuse results from the last 14 days, hits and clean misses alike.

## Community buying requests

`community-buyer-threads` finds Reddit and Hacker News posts asking for what you sell. Set `keywords`, `competitors` or both, up to 20 terms. Defaults: both platforms, the last 7 days, 25 rows, every six hours.

Relevant and uncertain threads wait for review; unrelated ones are saved as rejected. No email lookup is needed. Approve a row, then generate its draft or run `find drain community-reply`. Drafts use your product brief and say you are affiliated.

Nothing posts for you. **Open thread**, **Copy reply**, post it yourself, then **Mark posted**.

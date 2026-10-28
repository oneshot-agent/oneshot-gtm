# Status

**Assume green.** Every CLI command, play, finder and dashboard page, and the server's REST + SSE routes, are covered by the test suite — and verified end to end against the live OneShot API: every paid call type has made the live round trip, including the voice and SMS legs (`motion concierge` / `motion demo-no-show`), the PMF survey pair, reply triage, bounce harvesting, and `gmail placement`.

Last verified **2026-10-28** · Bun 1.3.13 · OneShot SDK 0.61.0 · **7270 tests / 550 files** · typecheck + oxlint + oxfmt pass (0 lint warnings, 0 errors). People a profile read from the last 14 days shows as first-degree connections (`network_distance`) get no connection request: the queue row or the cadence's request step records the connection without an invite or an invite slot, and the first message is due at once. If LinkedIn then answers `not_connected`, that record is withdrawn and the step drafts the connection request for review; the message follows its acceptance. The funnel counts these people as already connected, never as invites sent.

LinkedIn notes and messages are templates by default: seven steps (connection request with and without evidence, first message and its already-connected variant, last message with and without an offer, the after-reply note) filled with `{first_name}`, `{evidence}` and `{offer}`, no model call. Neutral defaults ship; a workspace sets its own on Setup → LinkedIn copy (`linkedin.templates`), and `linkedin.writer: "model"` keeps the prompt-written path.

**What the gate covers.** `apps/web` is now inside `bun run typecheck` — the dashboard source is
type-checked in CI, and a deliberate error under `apps/web/src` fails the root script. As of
2026-08-29, `apps/*/__tests__` is also included, so all app test files are type-checked. Coverage
is thin in two packages: `packages/doctor` has one test file against 799
lines of `check.ts`, and `packages/intel`'s `retry.test.ts` covers `client.ts`'s retry surface
(`backoffDelayMs`, `isRetryableLlmError`, `parseRetryAfter`, `complete()`'s OpenRouter paths),
while `reports.test.ts` covers `triageEmails`, `synthesizeInterviews`, `adviseOnce` and
`weeklyReview`, and `truncation.test.ts` covers `complete()`'s Anthropic path and the
`allowTruncation` split across all three providers.

**Dependency pins.** The root `package.json` carries `overrides` for `seroval`, `seroval-plugins`
(CVE-2026-59940) and `ws`. Forks inherit these.

The person-level ICP gate (#45) was calibrated against real LinkedIn titles before it shipped, and the workspace switcher's auto-start is verified in both directions (default ↔ a named workspace).

Reply detection was verified against real mailboxes: a sliced sweep of every inbox from the first send onward found exactly the replies the live poll recorded. Every inbound is classified (#63): out-of-office autoresponders, dead-mailbox notices and unsubscribes are kept in the conversation history but never count as replies, and the latter two durably suppress the address at the send funnel.

Shadow priority score (#410): the heuristic score is computed for every queued row but drives nothing until it clears the Phase 2 acceptance bar (gap ≥ +5, AUC ≥ 0.60). The ranked review order ships config-gated, with `queueReviewOrder` defaulting to `newest` (a toggle on /queue).

Industry packs (#458, #464): `GET /api/packs` + `POST /api/packs/:id/apply` hand a founder a working starting config for their vertical in one confirmation instead of a per-trigger `apply-config` conversation. A pack merges its patches over each trigger's stored config (hand-tuned keys survive) and enables every trigger it touches; a trigger left enabled-but-not-ready (missing a `requires` key the pack deliberately left blank) is the intended end state, named in the response. Nine packs ship: the `devtools-early-adopters` placeholder plus eight verticals (restaurants-food-service, home-services-trades, healthcare-practices, auto-services, professional-services-smb, trucking-freight, civic-gov, vertical-ai-startups). The main-street seven are wired to `local-business` and/or `local-registry`/`gov-solicitation`/`civic-agenda`, and their `local-business` runs on the SDK's places index (`engine: local`). `vertical-ai-startups` is the one pack whose buyers are software companies, so it wires the company-level sources instead (`accelerator-batch` with the registry's `yc-*`/`ai-grant-*` cohorts, `post-funding-auto`, `hiring-signal`, `github-topics`) and sets no `vendors`. A pack never writes `icpOneLiner` or any founder-voice field (`yourEdge`/`yourClaim`); those stay in `pack.requires` for the founder to fill in.

Grounding pipeline. `listProspectsForResearch` selects rows on `hasPersonSignal`, the same gate `_run-play.ts` / `_reply-research.ts` / `research-prospects.ts` use, so a row holding only the product half of a `{person, product}` dossier is still researched. `researchUrl` prefers a researchable profile (LinkedIn/X/GitHub) over a `luma.com/user/…` page with no content; `research-prospects` merges through `mergePersonDossier` instead of replacing the column; and `hasDossierSignal` does not count a profile page's own empty-state text as a sourced excerpt.

Person-level ICP verdicts are written by the send path. `QualifiedContact` carries the gate's verdict out of `_contact.ts`, the finders stamp it via `icpFields`, and `sendDraftedEmail` both persists it and **gates step 0 on it**, as follow-ups already were. `null` and `unclear` still fail open, per the contract in `ledger.ts`.

luma-events: the event relevance gate runs on title + description after the free structured fetch (`fetchEventDetails`), falling back to title-only before the paid `webRead`, so an event with a generic name is judged on what it is about. Stage-A role text falls through Luma's empty `bio_short` to the role. `companyDomain` is carried to the play, and `_product-research.ts` does not seed a company website from an academic/alumni email domain.

LinkedIn replies: `channel_events` has a `body` column, so a recorded reply can feed the composer. The manual mark keys `externalEventId` on a hash of `(prospectId, body)`, deliberately not of the clock, so `UNIQUE(source, external_event_id)` catches a duplicate mark either side of a minute boundary. The affordance lives on `/queue`, so prospects of one-touch plays that never enrol in a cadence are reachable too. `/api/run`'s `persistDraftsToQueue` links `target_queue.prospect_id`, as `drain.ts` does.

---

## Off by default

Every finder is off in a new workspace and is enabled per trigger from `/queue`. These also stay **not ready** until you give them required config, and refuse to fire until you do (the API returns `409`):

| Finder              | Needs                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accelerator-batch` | `cohorts[]` + `yourEdge`                                                                                                                                 |
| `job-change`        | `yourEdge`                                                                                                                                               |
| `hiring-signal`     | `yourClaim`                                                                                                                                              |
| `github-topics`     | `topics[]` + `vendors[]` + `yourEdge`                                                                                                                    |
| `github-stars`      | `repos[]` + `yourEdge`                                                                                                                                   |
| `luma-events`       | `topics[]` + `cities[]` + `yourEdge`                                                                                                                     |
| `x-reposters`       | `seeds[]` + engine credentials                                                                                                                           |
| `local-business`    | `jobTitles[]` or `industries[]` + `yourEdge`                                                                                                             |
| `local-registry`    | at least one of `portals[]` / `taxonomies[]`+`states[]` / `entityTypes[]` or `minPowerUnits`/`maxPowerUnits` (fmcsa, no `states[]` needed), + `yourEdge` |
| `gov-solicitation`  | `naics[]` + `yourEdge`                                                                                                                                   |
| `civic-agenda`      | `cities[]` + `keywords[]` + `yourEdge`                                                                                                                   |
| `list-page`         | `sources[]` (`{url, signal}` or `{companies, signal}`) + `play: design-partner-loi` + `buyerType` + `yourEdge`                                           |

Both GitHub finders need `GITHUB_TOKEN`. Unauthenticated, GitHub allows 60 requests/hour per IP **shared across the two** — one `github-stars` pass (each repo, up to 3 pages) can spend that alone, and the finder then halts on a `403` that reads like a dead endpoint rather than degrading to lower volume. A classic token with **no scopes** is enough for the public data both read, and lifts the ceiling to 5,000/hour. `doctor` warns when either finder is enabled without one. `luma-events` accepts an optional `LUMA_SESSION_COOKIE` to read authed guest lists. `x-reposters` needs the X credentials for whichever engine its config names (`xapi`: 4 OAuth1 keys, `twitterapiio`: 1 key) — settable from `/setup`'s X card or `config keys`, switchable with `config x-engine`.

## Known limitations

- **Bounce handling is Gmail-only.** DSNs are parsed from connected Gmail/Workspace mailboxes. Sends through OneShot domains and Smartlead mailboxes have no equivalent feed yet; `doctor` names them as not covered rather than reporting a false zero.
- **Smartlead mailboxes: no warmup ingestion or per-domain cap groups.** `smartlead connect` (or `/setup`) registers Smartlead-hosted mailboxes as sending identities — rotation, warm-up caps (clamped to Smartlead's own per-mailbox limit at registration; later Smartlead-side changes aren't re-synced), sticky threads, suppression, and the cross-workspace hold all apply. Each mailbox's IMAP is synced into `/inbox`, replies thread from the receiving mailbox, and a new mailbox sends through its own SMTP under one keyed Message-ID per email when its credentials resolve. A mailbox on the Smartlead API path has no idempotency key (a provider-side retry can double-send), so its copies in Sent are counted instead and `doctor` warns on it; `identities send-via <id> smtp` switches it. Follow-ups: bounce/warmup ingestion, per-domain cap groups.
- **`oneshot-gtm-server` requires Bun.** `bun:sqlite`, `Bun.serve`, and `Bun.stdin` are Bun-native; a runtime check in `dist/bin.mjs` fails loudly under plain `node`. A self-contained `bun build --compile` binary is a future option.
- **The CLI is not on npm.** Only `oneshot-gtm-server` is published. The CLI needs a repo clone plus `bun link`.
- **No public benchmarks page.** The telemetry endpoint is live and verified; the surface that renders aggregates from it is still roadmap.
- **The CLI has limited machine-readable output.** Read-only commands (`doctor`, `identities list`, `domains list`, `workspace list`, `find watch --once`, `find drain --dry-run`) now support `--json` for scripted callers. Mutation commands and multi-step flows still require the dashboard or `/api/measure/*` routes.
- **`events.jsonl` rotates at 10 MB.** `logEvent` rolls the live file to `events.1.jsonl` … `events.3.jsonl` and drops the oldest; `ONESHOT_GTM_MAX_EVENT_LOG_BYTES` moves the ceiling. A rotation failure drops the event rather than throwing, and `tail -f` needs to be `tail -F` to survive the rename.
- **Launch assets partially captured.** The 55-second voiced launch video is embedded at the top of the README. The vhs terminal recording and dashboard gif the roadmap calls for are still open; `demo seed` builds the populated fictional install to record them against.
- **Cross-workspace shared DB is additive.** Paid lookup caches and contact touches live in `~/.oneshot-gtm-shared/shared.sqlite` (`ONESHOT_GTM_SHARED` relocates it); each ledger's own cache tables are imported once on first use and then left unwritten, so rolling back is a code revert, not a data migration. The `contacted-elsewhere` hold is a soft flag — auto paths wait the 7-day window out, a manual queue send overrides.
- **Demo mode fixtures four network reads.** `listInbox`, `cadenceRocs`, `listSendingDomains` and `getBalance` read JSON from the demo home when `ONESHOT_GTM_DEMO=1`, and the scheduler idles. All four are reads; nothing that sends, drafts or spends is stubbed, and the flag is only ever set by `demo ui`. Under the flag the demo home's `.env` is also the **sole** source of secrets — inherited env vars and Bun's auto-loaded repo-root `.env` are overwritten or deleted, so a demo can never act with real credentials.

## GitHub stargazer discovery is degraded by upstream

GitHub restricted `/stargazers` to repo admins in July 2026. `github-stars` falls back to the public `/events` feed, which only exposes `WatchEvent`s within roughly a 90-day, 300-event window. Stars outside that window are invisible — not a bug in the finder.

## NPPES recency pagination has a hard ceiling on busy taxonomy×state pairs

`local-registry`'s nppes adapter (`fetchNppesPair` in `packages/find/src/_registry-sources.ts`) pages through NPPES's `skip`/`limit` API up to its own documented ceiling — 6 pages of 200, 1,200 records per taxonomy×state pair per run. The NPPES API has no `$order`-equivalent sort parameter, so this closes the "invisible past page 1" gap only when a pair's total result count is at or under 1,200. A busy pair that exceeds it (e.g. Dentist in a populous state like CA/TX/NY) can still leave a newly-enumerated provider past page 6 unseen, with no ordering guarantee to surface it sooner — unlike the Socrata adapter, which closes the equivalent gap for real via server-side `$order`+`$where`. Narrowing `states[]`/`taxonomies[]` to smaller pairs sidesteps it; there is no client-side fix for a pair NPPES itself won't sort.

## civic-agenda covers a curated city list, not every Legistar deployment

Legistar/Granicus covers 80%+ of US municipalities, but each deployment's client slug is an arbitrary string with no discovery API — `packages/find/src/_civic-legistar.ts` ships a curated `CITY_SLUGS` map (NYC, Chicago, Philadelphia, Oakland, San Francisco). An unmapped city is skipped with a logged reason rather than guessed at; extend the map as founders name more cities.

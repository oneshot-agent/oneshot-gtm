# Status

**Assume green.** The 51 CLI commands, 18 plays, 12 finders, nine dashboard pages plus the run form, and the server's REST + SSE routes are all covered by the test suite — and verified end to end against the live OneShot API: every paid call type has made the live round trip, including the voice and SMS legs (`motion concierge` / `motion demo-no-show`), the PMF survey pair, reply triage, bounce harvesting, and `gmail placement`.

Last verified **2026-09-03** · Bun 1.3.13 · OneShot SDK 0.22.0 · **2617 tests / 202 files** · typecheck + oxlint + oxfmt clean.

**What the gate covers.** `apps/web` is now inside `bun run typecheck` — the dashboard source is
type-checked in CI, and a deliberate error under `apps/web/src` fails the root script. As of
2026-08-29, `apps/*/__tests__` is also included, so all app test files are type-checked. Coverage
is thin in two packages: `packages/doctor` has one test file against 799
lines of `check.ts`, and `packages/intel` tests cover only `_parse.ts` and `prompts.ts`, not
`client.ts`, `triage`, `synthesize`, `advise` or `weekly-review`.

**Dependency pins.** The root `package.json` carries `overrides` for `seroval`, `seroval-plugins`
(CVE-2026-59940) and `ws`. Forks inherit these.

The person-level ICP gate (#45) was calibrated against 84 real LinkedIn titles (all 13 known off-ICP prospects caught, zero false rejects among 44 builders) and the history audit ran live `enrichProfile` for 111 titles. The workspace switcher's auto-start was live-verified in both directions (default ↔ gtm).

Reply detection was verified on 2026-08-23 against the real mailboxes: a sliced sweep of all four inboxes from the first send onward (4,833 inbound, every slice fully covered) found exactly the replies the live poll then recorded on restart. Since 2026-08-28 every inbound is also classified (#63) — out-of-office autoresponders, dead-mailbox notices and unsubscribes are recorded for the conversation history but never count as replies, and the latter two durably suppress the address at the send funnel.

Shadow priority score (#410): heuristic-v2 measured 2026-09-01 on 794 clean human labels — luma-events AUC 0.59-0.63 (up from v1's inverted 0.36), mean gap +1. Under the Phase 2 acceptance bar (gap ≥ +5, AUC ≥ 0.60), so the ranked review order shipped config-gated with `queueReviewOrder` defaulting to `newest` (a toggle on /queue; scores drive nothing else until richer features clear the bar).

Industry packs (#458): `GET /api/packs` + `POST /api/packs/:id/apply` hand a founder a working starting config for their vertical in one confirmation instead of a per-trigger `apply-config` conversation — a pack merges its patches over each trigger's stored config (hand-tuned keys survive) and enables every trigger it touches; a trigger left enabled-but-not-ready (missing a `requires` key the pack deliberately left blank) is the intended end state, named in the response. Ships with one placeholder pack (`devtools-early-adopters`); the real per-vertical pack library is a separate issue. Never writes `icpOneLiner` — the pack's proposed ICP rides back in the response for the founder to accept from `/setup`.

Updated by hand after each dogfood run.

---

## Off by default

Only **`show-hn`** and **`post-funding-auto`** fire out of the box. The other eleven finders are opt-in, enabled per trigger from `/queue`:

`accelerator-batch` · `job-change` · `hiring-signal` · `podcast-guest` · `luma-events` · `github-topics` · `github-stars` · `breakup-revive` · `x-reposters` · `local-business` · `local-registry`

Eight of those also stay **not ready** until you give them required config, and refuse to fire until you do (the API returns `409`):

| Finder              | Needs                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `accelerator-batch` | `cohorts[]` + `senderCohort`                                                                                                        |
| `hiring-signal`     | `yourClaim`                                                                                                                         |
| `github-topics`     | `topics[]` + `vendors[]` + `yourEdge`                                                                                               |
| `github-stars`      | `repos[]` + `yourEdge`                                                                                                              |
| `luma-events`       | `topics[]` + `cities[]` + `yourEdge`                                                                                                |
| `x-reposters`       | `seeds[]` + engine credentials                                                                                                      |
| `local-business`    | `jobTitles[]` or `industries[]` + `yourEdge`                                                                                        |
| `local-registry`    | (`portals[]` or `taxonomies[]`+`states[]` or `entityTypes[]`/`minPowerUnits`/`maxPowerUnits` or `inspectionPortals[]`) + `yourEdge` |

Both GitHub finders need `GITHUB_TOKEN`. Unauthenticated, GitHub allows 60 requests/hour per IP **shared across the two** — one `github-stars` pass (each repo, up to 3 pages) can spend that alone, and the finder then halts on a `403` that reads like a dead endpoint rather than degrading to lower volume. A classic token with **no scopes** is enough for the public data both read, and lifts the ceiling to 5,000/hour. `doctor` warns when either finder is enabled without one. `luma-events` accepts an optional `LUMA_SESSION_COOKIE` to read authed guest lists. `x-reposters` needs the X credentials for whichever engine its config names (`xapi`: 4 OAuth1 keys, `twitterapiio`: 1 key) — settable from `/setup`'s X card or `config keys`, switchable with `config x-engine`.

## Known limitations

- **Bounce handling is Gmail-only.** DSNs are parsed from connected Gmail/Workspace mailboxes. Sends through OneShot domains and Smartlead mailboxes have no equivalent feed yet; `doctor` names them as not covered rather than reporting a false zero.
- **Smartlead is send-only.** `smartlead connect` (or `/setup`) registers Smartlead-hosted mailboxes as sending identities — rotation, warm-up caps (clamped to Smartlead's own per-mailbox limit at registration; later Smartlead-side changes aren't re-synced), sticky threads, suppression, and the cross-workspace hold all apply — but replies land in Smartlead's inbox, not `/inbox`, and there is no bounce feed or send idempotency (a timeout-then-retry can double-send, same as Gmail). Follow-ups: an inbox source + threaded replies, bounce/warmup ingestion, per-domain cap groups.
- **`oneshot-gtm-server` requires Bun.** `bun:sqlite`, `Bun.serve`, and `Bun.stdin` are Bun-native; a runtime check in `dist/bin.mjs` fails loudly under plain `node`. A self-contained `bun build --compile` binary is a future option.
- **The CLI is not on npm.** Only `oneshot-gtm-server` is published (0.7.0). The CLI needs a repo clone plus `bun link`.
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

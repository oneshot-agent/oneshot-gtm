# Status

**Assume green unless it's listed below.** The 48 CLI commands, 14 plays, 10 finders, nine dashboard pages plus the run form, and the server's REST + SSE routes are all covered by the test suite — and, with the exceptions on this page, verified end to end against the live OneShot API.

Last verified **2026-08-25** · Bun 1.3.13 · OneShot SDK 0.22.0 · 1777 tests / 137 files · typecheck + oxlint clean.

The person-level ICP gate (#45) was calibrated against 84 real LinkedIn titles (all 13 known off-ICP prospects caught, zero false rejects among 44 builders) and the history audit ran live `enrichProfile` for 111 titles. The workspace switcher's auto-start was live-verified in both directions (default ↔ gtm).

Reply detection was verified on 2026-08-23 against the real mailboxes: a sliced sweep of all four inboxes from the first send onward (4,833 inbound, every slice fully covered) found exactly the replies the live poll then recorded on restart.

Updated by hand after each dogfood run. CI auto-update is on the roadmap.

---

## Not verified against live OneShot

Each of these needs a real-world input the test suite can't fake. The code paths are tested and typechecked; what's unproven is the round trip.

| Surface                       | Blocked on                                                                  |
| ----------------------------- | --------------------------------------------------------------------------- |
| `motion concierge`            | a real phone number — voice leg                                             |
| `motion demo-no-show`         | a real phone number — SMS leg                                               |
| `discover pmf survey`         | exercising the OneShot Build endpoint end-to-end (the landing page deploys) |
| `discover pmf survey-collect` | real replies in the OneShot inbox                                           |
| `intel triage-replies`        | real inbound replies                                                        |
| Bounce harvesting             | a real DSN arriving in a connected mailbox                                  |
| `gmail placement`             | a live canary run between two authorized mailboxes                          |

Every failure mode in the two deliverability paths is loud rather than silent — they surface an error rather than reporting a false negative.

## Off by default

Only **`show-hn`** and **`post-funding-auto`** fire out of the box. The other eight finders are opt-in, enabled per trigger from `/queue`:

`accelerator-batch` · `job-change` · `hiring-signal` · `podcast-guest` · `luma-events` · `github-topics` · `github-stars` · `breakup-revive`

Five of those also stay **not ready** until you give them required config, and refuse to fire until you do (the API returns `409`):

| Finder              | Needs                                 |
| ------------------- | ------------------------------------- |
| `accelerator-batch` | `cohorts[]` + `senderCohort`          |
| `hiring-signal`     | `yourClaim`                           |
| `github-topics`     | `topics[]` + `vendors[]` + `yourEdge` |
| `github-stars`      | `repos[]` + `yourEdge`                |
| `luma-events`       | `topics[]` + `cities[]` + `yourEdge`  |

`github-stars` also wants `GITHUB_TOKEN` for useful volume, and `luma-events` accepts an optional `LUMA_SESSION_COOKIE` to read authed guest lists.

## Known limitations

- **Bounce handling is Gmail-only.** DSNs are parsed from connected Gmail/Workspace mailboxes. Sends through OneShot domains and Smartlead mailboxes have no equivalent feed yet; `doctor` names them as not covered rather than reporting a false zero.
- **Smartlead is send-only.** `smartlead connect` (or `/setup`) registers Smartlead-hosted mailboxes as sending identities — rotation, warm-up caps (clamped to Smartlead's own per-mailbox limit at registration; later Smartlead-side changes aren't re-synced), sticky threads, suppression, and the cross-workspace hold all apply — but replies land in Smartlead's inbox, not `/inbox`, and there is no bounce feed or send idempotency (a timeout-then-retry can double-send, same as Gmail). Follow-ups: an inbox source + threaded replies, bounce/warmup ingestion, per-domain cap groups. The one live-unverified piece is the send round trip itself (`/send-email/initiate` against a real key).
- **`oneshot-gtm-server` requires Bun.** `bun:sqlite`, `Bun.serve`, and `Bun.stdin` are Bun-native; a runtime check in `dist/bin.mjs` fails loudly under plain `node`. A self-contained `bun build --compile` binary is a future option.
- **The CLI is not on npm.** Only `oneshot-gtm-server` is published (0.7.0). The CLI needs a repo clone plus `bun link`.
- **No public benchmarks page.** The telemetry endpoint is live and verified; the surface that renders aggregates from it is still roadmap.
- **Launch assets partially captured.** The 55-second voiced launch video is embedded at the top of the README. The vhs terminal recording and dashboard gif the roadmap calls for are still open; `demo seed` builds the populated fictional install to record them against.
- **Cross-workspace shared DB is additive.** Paid lookup caches and contact touches live in `~/.oneshot-gtm-shared/shared.sqlite` (`ONESHOT_GTM_SHARED` relocates it); each ledger's own cache tables are imported once on first use and then left unwritten, so rolling back is a code revert, not a data migration. The `contacted-elsewhere` hold is a soft flag — auto paths wait the 7-day window out, a manual queue send overrides.
- **Demo mode fixtures four network reads.** `listInbox`, `cadenceRocs`, `listSendingDomains` and `getBalance` read JSON from the demo home when `ONESHOT_GTM_DEMO=1`, and the scheduler idles. All four are reads; nothing that sends, drafts or spends is stubbed, and the flag is only ever set by `demo ui`. Under the flag the demo home's `.env` is also the **sole** source of secrets — inherited env vars and Bun's auto-loaded repo-root `.env` are overwritten or deleted, so a demo can never act with real credentials.

## GitHub stargazer discovery is degraded by upstream

GitHub restricted `/stargazers` to repo admins in July 2026. `github-stars` falls back to the public `/events` feed, which only exposes `WatchEvent`s within roughly a 90-day, 300-event window. Stars outside that window are invisible — not a bug in the finder.

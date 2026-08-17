# Status

**Assume green unless it's listed below.** The 38 CLI commands, 14 plays, 10 finders, nine dashboard pages plus the run form, and the server's REST + SSE routes are all covered by the test suite — and, with the seven exceptions on this page, verified end to end against the live OneShot API.

Last verified **2026-08-17** · Bun 1.3.13 · OneShot SDK 0.22.0 · 1487 tests / 115 files · typecheck + oxlint clean (295 files).

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

- **Bounce handling is Gmail-only.** DSNs are parsed from connected Gmail/Workspace mailboxes. Sends through OneShot domains have no equivalent feed yet, so their bounce rate reads as zero rather than unknown.
- **`oneshot-gtm-server` requires Bun.** `bun:sqlite`, `Bun.serve`, and `Bun.stdin` are Bun-native; a runtime check in `dist/bin.mjs` fails loudly under plain `node`. A self-contained `bun build --compile` binary is a future option.
- **The CLI is not on npm.** Only `oneshot-gtm-server` is published (0.7.0). The CLI needs a repo clone plus `bun link`.
- **No public benchmarks page.** The telemetry endpoint is live and verified; the surface that renders aggregates from it is still roadmap.
- **Launch assets not captured.** The terminal recording and dashboard gif the roadmap calls for don't exist yet, so no doc embeds one.

## GitHub stargazer discovery is degraded by upstream

GitHub restricted `/stargazers` to repo admins in July 2026. `github-stars` falls back to the public `/events` feed, which only exposes `WatchEvent`s within roughly a 90-day, 300-event window. Stars outside that window are invisible — not a bug in the finder.

# Roadmap

What isn't built yet. Shipped work lives in `git log` and the release tags (v0.1.0 → v0.7.0).

Public — issues mirror the items below, PRs welcome. Items carry an effort tag (S/M/L) and a
`Done when:` line, so an agent can pick one up without a conversation first.

---

## In flight

_Nothing in flight._

---

## Real-time intake

Today every finder polls. These turn it push.

- [ ] **Warm-signal escalation** in cadence (open-tracking → auto phone call). Blocked: needs OneShot to surface open events.

## Gates and coverage

The verify gate has holes an agent can close without touching product behaviour. Ranked.

## Reliability

## Learning loop

The ICP filter currently judges each candidate cold — `icpFilter` in `packages/find/src/_filter.ts` sends the model nothing but `{ icp, candidate }`.

- [ ] **v2** — periodic job proposes a tighter ICP one-liner from accumulated decisions; founder approves the rewrite in `/queue`.

## Operations

- [ ] **BYO sending domain** — send from a domain you already own over OneShot's transport, instead of one OneShot provisions. Connecting a Gmail/Workspace account is today's workaround.

## Measurement

- [ ] **Public benchmarks page** reading aggregates from the telemetry table. The pipeline exists; this is the surface.

## Integrations

- [ ] CRM adapters: Attio, Folk, Pipedrive.
- [ ] Linear notification webhook. Slack is in flight above.

## Tech debt

**Done (#751, closing the ledger.ts SQL-extraction series: receipts #616, cache #618, delivery-health #617, inbox #634, queue #641, cadence #642, prospects #643, and this slice's direct-mail/runs/triggers/meetings/outcomes/sending/spend/markers/admin/system):** every remaining SQL statement and transaction body in `packages/core/src/ledger.ts` has been extracted to the store that owns its table — `ledger-direct-mail.ts` (direct-mail drafts, mail preparations, the shared postal-address book, mail receipts), `ledger-runs.ts` (`runs`), `ledger-triggers.ts` (`triggers`), `ledger-meetings.ts` (`meetings`), `ledger-outcomes.ts` (`deal_outcomes`), `ledger-sending.ts` (`sender_assignments` and identity-scoped send accounting), `ledger-spend.ts` (`spend_reservations`), `ledger-markers.ts` (the shared CAS claim/clear-marker helper, now used by both `cadence_state` and `triggers`), `ledger-admin.ts` (WAL/VACUUM/optimize housekeeping and the busy-timeout constant), and `ledger-system.ts` (poll watermarks, webhook-replay protection, the paid-discovery retry queue, discovery interviews, and the cross-domain `listColdProspects` finder query). A handful of cross-domain sequence-event/channel-event reads (`listSequenceEventsForProspect`, `listAllSequenceEventsForProspect`, `listChannelEventsForProspect`, `hasOutreachHistory`, `lastOutreachAt`, `countSends`, `eventsByPlay`, `prospectHasFirstTouch`) moved into `ledger-cadence.ts` alongside the cadence methods that already read the same table. `Ledger` stays the compatibility facade: every method keeps its existing public signature, return value, error, ordering, and transaction boundary, and no call site needed migration. An architecture test (`packages/core/__tests__/ledger-no-inline-sql.test.ts`) enforces this structurally (bans any `this.db.query/prepare/exec/run` call in `ledger.ts` outright, plus a case-insensitive keyword scan covering CTEs/`REPLACE INTO`/`PRAGMA` as defense-in-depth) and fails the build if executable SQL is reintroduced. **Round-1 correction:** the shared-person identity resolution (`refreshSharedPeople`/`bindSharedPerson`/`withSharedIdentity`/`upsertProspect`'s transaction body) that this note previously said was "left in `ledger.ts` itself, by design" has now moved into `ledger-prospects.ts`'s `ProspectStore` (`refreshSharedIdentity`, `bindSharedPerson`, `withSharedIdentity`, `upsertProspectWithIdentity`), scoped via a new `ProspectSharedIdentity` interface that `Ledger`'s constructor implements with closures over its own `path`. `Ledger` now keeps only the generic `transaction()` escape hatch and thin one-line delegates (`refreshSharedPeople`, `upsertProspect`, `getProspectById`) — no domain logic of its own.

## Launch assets

Not code — these need capture, not commits. `demo seed` + `demo ui` now stand up a populated, fictional install to record against, so neither is blocked on having something to point a camera at.

- [ ] vhs terminal recording (60s), to embed in the README.
- [ ] Dashboard demo gif (30s).
- [ ] Launch posts — drafts maintained privately, unpublished.
- [ ] Fireship sponsor video.
- [ ] "Built with oneshot-gtm" badge program. The artifact shipped; this is the adoption push.

---

## Approved, not yet started

_Nothing approved and waiting._

## Things we intentionally do NOT do

- **Run an SDR.** This helps you do founder-led sales. It refuses to advise a `first-ae` hire pre-PMF.
- **Manage SPF/DKIM/DMARC.** OneShot auto-provisions and warms sending domains.
- **Hold your customer data.** Local SQLite ledger only.
- **Lock you into our LLM.** BYO key, swap providers freely.
- **Auth, multi-user, hosted DB.** Local-first stays local. That's OneShot Cloud's problem.
- **A universal cross-wrapper dashboard.** Separate future product that would aggregate receipts across `oneshot-gtm`, `oneshot-support`, etc.
- **Extract `@oneshot/wrapper-kit`.** Deferred until a second wrapper exists.
- **Tauri / Electron desktop wrap.** `bunx oneshot-gtm-server` opens your browser; that's enough.
- **Adopt Effect.** Skipped for shipping speed. Plain `async`/`await` keeps the code forkable.

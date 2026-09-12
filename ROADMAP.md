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

- [ ] **Split `packages/core/src/ledger.ts`** · L — 2967 lines covering receipts, prospects, queue, cadence, inbox, bounces, canaries and caches behind one class, with `migrate()` at 400 lines of inline DDL.
      _Done when:_ the file is split by domain with the exported class surface and every call site unchanged, `migrate()` still produces a byte-identical schema for a fresh install, and `packages/core/__tests__/ledger.test.ts` passes untouched.
      _Progress (#452):_ fresh-install schema construction + inline migrations extracted to `packages/core/src/ledger-schema.ts`; `Ledger.migrate()` now delegates to it. Byte-identical fresh-install schema verified (sqlite_master + schema_version snapshot in `ledger.test.ts`); domain methods (receipts, prospects, queue, cadence, inbox, bounces, canaries, caches) remain in `ledger.ts` for a follow-up slice.
      **Progress (#616):** receipt reads, writes, attribution and aggregation extracted to `packages/core/src/ledger-receipts.ts` as a `ReceiptStore` constructed from the migrated `Database` handle; `Ledger` delegates every receipt method to it with signatures, return values and transaction boundaries unchanged. Prospects, queue, cadence, inbox, bounces, canaries and caches remain in `ledger.ts` for further slices (bounces/canaries tracked as issue #617).

      _Progress (#618):_ cache get/set/expiry/invalidation extracted to `packages/core/src/ledger-cache.ts`; `Ledger` delegates to a `LedgerCache` instance, keeping identical public method signatures and TTL constants. Receipts, prospects, queue, cadence, inbox, bounces and canaries remain in `ledger.ts` for further slices.

      **Progress (#617):** bounce, suppression, and canary persistence extracted to `packages/core/src/delivery-health.ts` (pure functions of a raw `Database` handle, mirroring the `ledger-schema.ts` pattern); `Ledger`'s recordBounce/suppressionFor/contactSuppressionFor/bounceStatsByIdentity/listRecentBounces/countBounces/countAutoPermanentBounces/recordCanaryResult/latestCanaryResult/latestSentEmailCopy now delegate to it, same signatures and SQL, every call site unchanged. Prospects, queue, cadence, and inbox domain methods remain in `ledger.ts` for further slices.

## Launch assets

Not code — these need capture, not commits. `demo seed` + `demo ui` now stand up a populated, fictional install to record against, so neither is blocked on having something to point a camera at.

- [ ] vhs terminal recording (60s), to embed in the README.
- [ ] Dashboard demo gif (30s).
- [ ] Launch posts — drafts are in `launch/`, unpublished.
- [ ] Fireship sponsor video.
- [ ] "Built with oneshot-gtm" badge program. The artifact shipped; this is the adoption push.

---

## Approved, not yet started

- [ ] **refactor(core): extract queue persistence from Ledger** — issue #631.
- [ ] **refactor(core): extract prospect and research persistence from Ledger** — issue #632.
- [ ] **refactor(core): extract cadence persistence from Ledger** — issue #633.

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

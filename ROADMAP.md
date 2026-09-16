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

      _Progress (#618):_ cache get/set/expiry/invalidation extracted to `packages/core/src/ledger-cache.ts`; `Ledger` delegates to a `LedgerCache` instance, keeping identical public method signatures and TTL constants. Receipts, prospects, queue, cadence, inbox, bounces and canaries remain in `ledger.ts` for further slices.

      **Progress (#617):** bounce, suppression, and canary persistence extracted to `packages/core/src/delivery-health.ts` (pure functions of a raw `Database` handle, mirroring the `ledger-schema.ts` pattern); `Ledger`'s recordBounce/suppressionFor/contactSuppressionFor/bounceStatsByIdentity/listRecentBounces/countBounces/countAutoPermanentBounces/recordCanaryResult/latestCanaryResult/latestSentEmailCopy now delegate to it, same signatures and SQL, every call site unchanged. Prospects, queue, cadence, and inbox domain methods remain in `ledger.ts` for further slices.

      **Progress (#634):** inbound-message recording, conversation/thread reads, reply classification state, archive/reopen operations, and inbox-specific transactions extracted to `packages/core/src/ledger-inbox.ts` as an `InboxStore` constructed from the migrated `Database` handle (same pattern as `ReceiptStore`/`LedgerCache`); `Ledger` delegates every inbox method to it with signatures, dedup behavior, ordering and transaction boundaries unchanged. No inbox-only SQL remains inline in `ledger.ts`. Prospects, queue and cadence domain methods remain in `ledger.ts`, tracked as issues #631–#633.

      **Progress (#641):** queue (`target_queue`) reads, writes, state transitions, selection/drain operations and queue-only transactions extracted to `packages/core/src/ledger-queue.ts` as a `QueueStore` constructed from the migrated `Database` handle; `Ledger` delegates every existing queue method to it with unchanged public signatures, return values, errors, and transaction boundaries — including the sent-row re-approval guard (`throwIfSentRowGuardBlocked`) and the `send_started_at`/`sent_at` invariants. No queue-only SQL remains inline in `ledger.ts`. Prospects and cadence domain methods remain in `ledger.ts`, tracked as issue #632–#633.

      **Progress (#642):** cadence creation, lookup, step advancement, skip records, stop/disposition handling, due-step queries, and cadence-specific transactions (recordCadenceReply/recordProspectReply/recordLinkedInReply, each of which stops live cadences and expires queued breakup-revive rows in one transaction) extracted to `packages/core/src/ledger-cadence.ts`, mirroring the `delivery-health.ts` pattern; `Ledger` delegates every cadence method — enrollCadence/listActiveCadences/listAllCadences/getCadence/listCadencesForProspect/advanceCadence/recordCadenceSendError/setCadenceStatus/stopCadence/setCadenceDraft/getCadenceDraft/clearCadenceDraft/sweepStaleCadenceSends/recordLinkedInReply/markLatestStepReplied/recordCadenceReply/recordProspectReply/latestSentPlayForProspect/getCadencePlan/saveCadencePlan/recordSequenceEvent/hasSentSequenceEvent/listSequenceEventsForProspectPlay/listSequenceEventsForCadences/recentSentEmailBodies/breakupReviveHoldFor — same signatures, SQL, and transaction boundaries, every call site unchanged, including `expireBreakupReviveQueue` (called from `stopCadence`/`recordLinkedInReply`/`recordProspectReply`) which now calls `QueueStore.expireBreakupReviveQueue` directly instead of through a `Ledger` private delegate. No cadence-only SQL remains inline in `ledger.ts` (verified by grep for INSERT/UPDATE/SELECT against `cadence_state` — the remaining inline references are multi-table prospect/queue queries that also touch `cadence_state`, not cadence-only reads). Prospects domain methods remain in `ledger.ts`, tracked as issue #632.

      **Progress (#643):** prospect CRUD, research-backlog queries (`listProspectsForResearch`/`listProspectsForAngle`/`listProspectsMissingLinkedIn`/`listProspectsForFuzzyMatch`), dossier merge/update operations (`mergeProspectDossierHalf`, `setProspectDossier`, `setProspectAngle`), person/company facts (`setProspectCurrentRole`, `updateProspectIdentity`) and stored ICP-verdict persistence (`setProspectIcpVerdict`) extracted to `packages/core/src/ledger-prospects.ts` as a `ProspectStore`, alongside `canonicalLinkedInProfileKey` (re-exported from `ledger.ts` unchanged); `Ledger` delegates every prospect method to it with signatures, return values, null handling and transaction boundaries unchanged, including the partial person/product dossier-merge invariant (`mergeProspectDossierHalf` re-reads the row inside its own `BEGIN IMMEDIATE` transaction so neither half can be silently reverted by a concurrent writer). The shared-people cross-workspace identity resolution (`SharedPeople`/`bindSharedPerson`/`withSharedIdentity`/`refreshSharedPeople`) stays in `ledger.ts`, since it needs the `Ledger` instance's own `path`/`people` fields rather than a bare `Database` handle; `Ledger`'s `findProspectByEmail`/`getProspectById`/`upsertProspect` wrap the shared-identity resolution around plain `ProspectStore` calls. Cross-domain prospect queries that JOIN `cadence_state`/`sequence_events`/`inbox_replies`/`channel_events`/`target_queue` (`listActiveCadences`, `listColdProspects`, `listRepliedProspectEmails`, `recordLinkedInReply`, etc.) stay in `ledger.ts`. This was the last of the seven ledger-split slices tracked here (receipts #616, cache #618, delivery-health #617, inbox #634, queue #641, cadence #642, prospects #643); no domain-specific SQL remains inline in `ledger.ts` outside the cross-domain JOIN queries by design.

## Launch assets

Not code — these need capture, not commits. `demo seed` + `demo ui` now stand up a populated, fictional install to record against, so neither is blocked on having something to point a camera at.

- [ ] vhs terminal recording (60s), to embed in the README.
- [ ] Dashboard demo gif (30s).
- [ ] Launch posts — drafts are in `launch/`, unpublished.
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

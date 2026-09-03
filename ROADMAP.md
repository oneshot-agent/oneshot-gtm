# Roadmap

What isn't built yet. Shipped work lives in `git log` and the release tags (v0.1.0 → v0.7.0).

Public — issues mirror the items below, PRs welcome. Items carry an effort tag (S/M/L) and a
`Done when:` line, so an agent can pick one up without a conversation first.

---

## In flight

- **feat(notify): Slack incoming-webhook notifications for replies, bounces, and daily send summary** — PR #74, issue #71.

---

## Real-time intake

Today every finder polls. These turn it push.

- [ ] **Warm-signal escalation** in cadence (open-tracking → auto phone call). Blocked: needs OneShot to surface open events.

## Gates and coverage

The verify gate has holes an agent can close without touching product behaviour. Ranked.

## Reliability

- [ ] **Install-wide daily spend ceiling** · M — spend caps are per trigger run (`maxCostUsd`, `maxSpendPerRun` in `packages/find/src/registry.ts`). Eleven finders on their own intervals, plus drains and cadence steps, have no shared daily bound and no kill switch.
      _Done when:_ a configurable daily USD ceiling is checked before any paid call; crossing it halts finders and auto-drains with a named reason surfaced on the trigger cards and in `doctor`; manual sends from `/queue` still go through; the counter resets at local midnight and is covered by tests around the boundary.
      _Done when:_ `--once` exits 1 if any due trigger errored, 0 otherwise; the daemon loop keeps its current behaviour; both covered.

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

## Launch assets

Not code — these need capture, not commits. `demo seed` + `demo ui` now stand up a populated, fictional install to record against, so neither is blocked on having something to point a camera at.

- [ ] vhs terminal recording (60s), to embed in the README.
- [ ] Dashboard demo gif (30s).
- [ ] Launch posts — drafts are in `launch/`, unpublished.
- [ ] Fireship sponsor video.
- [ ] "Built with oneshot-gtm" badge program. The artifact shipped; this is the adoption push.

---

## Approved, not yet started

- [ ] **Deferred review findings from ai/gtm/issue-430** — issue #433.
- [ ] **Deferred review findings from ai/gtm/issue-434** — issue #439.

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

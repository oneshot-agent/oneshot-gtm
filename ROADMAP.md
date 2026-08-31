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

- [ ] **Webhook intake** — `POST /api/triggers/cal-no-show` + `POST /api/triggers/signup` → ICP-filter → enqueue into `demo-no-show` / `concierge`.
- [ ] **Webhook signing + replay protection** for those endpoints.
- [ ] **Warm-signal escalation** in cadence (open-tracking → auto phone call). Blocked: needs OneShot to surface open events.

## Gates and coverage

The verify gate has holes an agent can close without touching product behaviour. Ranked.

- [ ] **Assert the README's own counts in a test** · S — README says "48 commands", "47-command CLI" and "1621 cases across 126 files". The real numbers are 49, 49 and 2010/158. The counts drift on every feature PR because nothing checks them.
      _Done when:_ a test derives the leaf-command count from the commander tree and the play/finder counts from the registries, asserts each against the README text, and fails on drift.
- [ ] **Prompt inventory test** · S — `packages/prompts` ships 57 markdown files; `agent-builder-extract.md` is referenced by nothing. Prompts are the product here, so an orphan is a fork reading a file the model never sees.
      _Done when:_ a test walks `packages/prompts/*.md`, resolves every name reachable through `loadPrompt` (including the play-derived `${play}-email` / `${play}-followup` shapes), and fails on either an orphan file or a loaded name with no file. Deliberate orphans go in an explicit allow-list with a reason.
- [ ] **Cover `packages/doctor`** · M — `check.ts` is 799 lines running the deliverability, placement, workspace-collision, GitHub-token and X-credential checks, and `__tests__/workspace-checks.test.ts` is the only test file. Doctor is what a new user reads first when something is wrong.
      _Done when:_ each named check has a case for its pass, warn and fail verdict against a stubbed ledger/config, and the bounce-rate thresholds (warn >2%, fail >5%, 20-send minimum) are pinned.
- [ ] **Cover `packages/intel`** · M — `parse.test.ts`, `prompts.test.ts` and `retry.test.ts` exist. `retry.test.ts` covers `client.ts`'s retry surface — `backoffDelayMs`, `isRetryableLlmError`, `parseRetryAfter` and `complete()`'s OpenRouter retry paths. Still untested: `triage.ts`, `synthesize.ts`, `advise.ts`, `weekly-review.ts`, `complete()`'s Anthropic path, and the `allowTruncation` split — the branch that decides whether a truncated response is returned as prose or thrown at a JSON caller.
      _Done when:_ `complete()` has cases for each provider path, the `allowTruncation` split, and the reasoning-tokens vs plain-overrun message; the four report modules have cases for a well-formed and a malformed model response.

## Reliability

- [ ] **Install-wide daily spend ceiling** · M — spend caps are per trigger run (`maxCostUsd`, `maxSpendPerRun` in `packages/find/src/registry.ts`). Eleven finders on their own intervals, plus drains and cadence steps, have no shared daily bound and no kill switch.
      _Done when:_ a configurable daily USD ceiling is checked before any paid call; crossing it halts finders and auto-drains with a named reason surfaced on the trigger cards and in `doctor`; manual sends from `/queue` still go through; the counter resets at local midnight and is covered by tests around the boundary.
      _Done when:_ `--once` exits 1 if any due trigger errored, 0 otherwise; the daemon loop keeps its current behaviour; both covered.

## Learning loop

The ICP filter currently judges each candidate cold — `icpFilter` in `packages/find/src/_filter.ts` sends the model nothing but `{ icp, candidate }`.

- [ ] **v1** — feed the last ~20 `(candidate, decision, reason)` tuples from `target_queue` into each `icpFilter` call as in-context examples. No schema change.
- [ ] **v2** — periodic job proposes a tighter ICP one-liner from accumulated decisions; founder approves the rewrite in `/queue`.
- [ ] **Per-source weighting** — track approval rate per finder, deprioritize noisy sources automatically.

## Operations

- [ ] **`--json` output on read-only commands** · M — `apps/cli/src/output.ts` is kleur-formatted prose and there is no `--json` flag anywhere in the CLI. The README already points scripted callers at `/api/measure/*` because the terminal has nothing machine-readable, which means booting a server to read your own ledger.
      _Done when:_ `doctor`, `find watch --once`, `find drain --dry-run`, `identities list`, `domains list` and `workspace list` accept `--json` and emit one parseable object on stdout with all human formatting and colour suppressed; a schema test pins each shape.
- [ ] **Bulk CSV import** — `find import --csv <file> --play <name>` with column mapping, for cohorts you already paid Clay/Apollo to source.
- [ ] **BYO sending domain** — send from a domain you already own over OneShot's transport, instead of one OneShot provisions. Connecting a Gmail/Workspace account is today's workaround.

## Measurement

- [ ] **`measure benchmark`** — opt-in cohort comparisons. Unblocked: the telemetry endpoint is live.
- [ ] **Public benchmarks page** reading aggregates from the telemetry table. The pipeline exists; this is the surface.

## Integrations

- [ ] CRM adapters: Attio, Folk, Pipedrive.
- [ ] Linear notification webhook. Slack is in flight above.

## Tech debt

- [ ] **Surface the server's error body on GET** · S — `getJson` in `apps/web/src/api/client.ts` throws `${status} ${statusText}: ${path}` and discards the `{ error }` JSON the server sends; `postJson` right below it reads the body. A 409 from a not-ready trigger reaches the dashboard as "409 Conflict" with the reason thrown away.
      _Done when:_ `getJson` parses the error body the same way `postJson` does and falls back to the status line when the body isn't JSON; covered by a test with a mocked `fetch`.
- [ ] **Extract the pure logic out of `queue.tsx`** · M — the route is 1869 lines, the largest file in `apps/web`, and its selection, filter, bulk-approve and drain-eligibility rules are inlined where no test can reach them. `src/lib/` already holds this shape of helper (`drainButton.ts`, `pruneSentRows.ts`, `replyFilter.ts`).
      _Done when:_ those rules move to `src/lib/` as pure functions with tests, the route imports them, and the rendered markup is byte-identical for a fixed props fixture.
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

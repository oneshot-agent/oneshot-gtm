# Roadmap

What isn't built yet. Shipped work lives in `git log` and the release tags (v0.1.0 → v0.7.0).

Public — issues mirror the items below, PRs welcome.

---

## Real-time intake

Today every finder polls. These turn it push.

- [ ] **Webhook intake** — `POST /api/triggers/cal-no-show` + `POST /api/triggers/signup` → ICP-filter → enqueue into `demo-no-show` / `concierge`.
- [ ] **Webhook signing + replay protection** for those endpoints.
- [ ] **Warm-signal escalation** in cadence (open-tracking → auto phone call). Blocked: needs OneShot to surface open events.

## Learning loop

The ICP filter currently judges each candidate cold.

- [ ] **v1** — feed the last ~20 `(candidate, decision, reason)` tuples from `target_queue` into each `icpFilter` call as in-context examples. No schema change.
- [ ] **v2** — periodic job proposes a tighter ICP one-liner from accumulated decisions; founder approves the rewrite in `/queue`.
- [ ] **Per-source weighting** — track approval rate per finder, deprioritize noisy sources automatically.

## Operations

- [ ] **`find watch` as an OS service** — launchd plist + systemd unit + Windows Service docs. `--once` already works under cron.
- [ ] **Bulk CSV import** — `find import --csv <file> --play <name>` with column mapping, for cohorts you already paid Clay/Apollo to source.
- [ ] **BYO sending domain** — send from a domain you already own over OneShot's transport, instead of one OneShot provisions. Connecting a Gmail/Workspace account is today's workaround.

## Measurement

- [ ] **`measure benchmark`** — opt-in cohort comparisons. Unblocked: the telemetry endpoint is live.
- [ ] **Public benchmarks page** reading aggregates from the telemetry table. The pipeline exists; this is the surface.

## Integrations

- [ ] CRM adapters: Attio, Folk, Pipedrive.
- [ ] Slack / Linear notification webhooks.

## Launch assets

Not code — these need capture, not commits.

- [ ] vhs terminal recording (60s), to embed in the README.
- [ ] Dashboard demo gif (30s).
- [ ] Launch posts — drafts are in `launch/`, unpublished.
- [ ] Fireship sponsor video.
- [ ] "Built with oneshot-gtm" badge program. The artifact shipped; this is the adoption push.

---

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

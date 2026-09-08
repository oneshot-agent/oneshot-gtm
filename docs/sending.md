# Sending and deliverability

Outbound ships through a **sender identity pool** — any mix of OneShot wallet-owned sending domains (several domains, several mailboxes per domain), your own Gmail / Workspace accounts, and Smartlead-hosted mailboxes. With no pool configured, behavior is the classic single OneShot identity.

## Adding identities

- **OneShot domain + mailbox** — `/setup` or `identities add`. Pick a provisioned domain or type a new one to auto-provision on first send. `domains list · pause · resume` manages the provisioned pool.
- **Gmail / Workspace** — `gmail auth` (one-time OAuth; needs a Google Cloud _Desktop_ client with the Gmail API on).
- **Smartlead** — `smartlead connect` (paste the workspace API key, pick from your connected accounts) or `/setup`. Smartlead does the warmup and hosts the inboxes; the default ramp ceiling clamps to each mailbox's own Smartlead limit. **Send-only for now**: replies to Smartlead-sent mail appear in Smartlead's inbox, not `/inbox`, and its bounces aren't harvested — like OneShot identities, `doctor` reports them as not bounce-covered.

## Rules the pool enforces

- **Sticky threads.** Every email to a prospect comes from the identity that sent their first touch, across plays and cadence steps. In-flight conversations never switch From address.
- **Warm-up caps, per domain.** A new identity ramps 10/day, +10/week, to a 50 ceiling — editable per identity on `/setup`. OneShot reputation is per-domain, so every mailbox on a domain shares one ramp and budget. Gmail accounts ramp per account.
- **Defer, never exceed.** When every identity is at cap, cadence steps stay due and queue rows stay approved until midnight. Nothing sends over cap.
- **One founder, one inbox, however many products.** A [workspace](./workspaces.md) never first-touches someone another workspace emailed in the last 7 days: the draft is held with a `contacted-elsewhere` flag that you can override on a manual send, and auto paths (drain, cadence steps) wait the window out. Touches and the paid lookup caches live in one shared SQLite (`~/.oneshot-gtm-shared/`), so the same person is never researched twice.
- **Idempotent sends.** Sends carry an idempotency key, so a retry after a timeout can't double-send.

## Replies

The inbox poll merges the OneShot inbox with every authorized Gmail account, so stop-on-reply works whichever identity sent. It walks everything since its last clean poll — a persisted watermark with an hour of overlap, paged newest-first, parking anything beyond one poll's page budget as a backlog the next ticks drain — so a reply is delayed by an outage, never lost to it. A reply you've already read and archived still counts.

Every inbound is classified: out-of-office autoresponders, dead-mailbox notices and unsubscribes are recorded for the conversation history but never count as replies, and the latter two durably suppress the address at the send funnel.

Answering from `/inbox` records the reply, sends from the receiving identity, and threads on both transports — Gmail via `In-Reply-To`/`References`, OneShot via `reply_to_email_id`. Drafting is research-grounded: known prospects reuse their stored dossier, unknown senders get enriched and their site read (~$0.06, cached 30 days, receipted under `inbox-reply`), and replies may cite links from your product brief — never invented ones.

LinkedIn replies stop email too — by hand from `/cadences` or through the [LinkedIn reply webhook](./webhooks.md#linkedin-reply-webhook).

## Deliverability

- **Bounces.** Delivery status notifications are harvested from connected Gmail mailboxes on a 30-minute sweep, parsed per RFC 3464, and classified hard / block / soft. A hard bounce stops the cadence and suppresses the address at both draft and send time; a `5.7.x` policy block never suppresses, being a verdict on the message rather than the mailbox. `doctor` reports a per-identity rate — warn above 2%, fail above 5%, 20-send minimum. Gmail-only for now.
- **Inbox placement.** `gmail placement` sends one real message between two authorized mailboxes and reads back where the receiving account filed it, plus the SPF/DKIM/DMARC verdicts that server recorded — a verdict on the real send path, needing no DNS tooling. It's never run automatically, since repeated canaries train the seed mailbox's filter.

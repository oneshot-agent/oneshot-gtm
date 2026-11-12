# Sending and deliverability

A cap you can talk past is not a cap. A new sender starts at 10 a day, earns 10 more each week, and stops at 50. Once the day's quota is used nothing more sends; the step stays due until midnight.

Mail leaves through a pool of sender identities: OneShot sending domains, your own Gmail or Workspace accounts, and Smartlead-hosted mailboxes, in any mix.

## Adding identities

- **OneShot domain and mailbox.** Setup, or `identities add`. Pick an active address on a provisioned domain, or review and buy domain/address setup separately. Setup never sends an email. `domains list`, `pause` and `resume` manage them.
- **Gmail or Workspace.** `gmail auth`, a one-time OAuth. It needs a Google Cloud Desktop client with the Gmail API on.
- **Smartlead.** `smartlead connect`, or Setup. Smartlead warms and hosts the mailbox. oneshot-gtm sends through the mailbox's own SMTP when its credentials resolve, and through the Smartlead API otherwise. `doctor` names every mailbox still on the API and the command that switches it: `identities send-via <id> smtp`.

`identities test-send <id> --to you@example.com --dry-run` shows what a test would send.

## The rules

- **One sender per person.** Every email to a prospect comes from the identity that sent the first one, across plays and steps.
- **Ramp.** 10 a day, plus 10 a week, to 50. Editable per identity on Setup. Mailboxes on one OneShot domain share one ramp within a workspace, because reputation belongs to the domain. Two workspaces on the same domain each count their own, so give each workspace its own domain. Gmail and Smartlead mailboxes ramp per account, and a Smartlead mailbox never exceeds its own Smartlead limit.
- **Defer, never exceed.** Capacity is reserved before a send starts, so two sends at once cannot both take the last slot. A send whose outcome is unknown still counts toward the cap. At the cap, steps stay due and rows stay approved.
- **One person, one product at a time.** A workspace does not first-touch someone another [workspace](./workspaces.md) emailed in the last 7 days. The draft is flagged `contacted-elsewhere`. Cadences shows the step as held and a batch skips it. You can override on a single manual send.
- **Drafts follow your setup.** A stored draft (a queue draft or a follow-up preview) is sent word for word, so each is stamped with the setup it was written under: voice card and its overrides, learned preferences, admission, credentials, cohort, product one-liner, brief and terms, offer exclusions, whether the play makes an offer, the signature, and the drafting and offer prompt versions. Change any of them and the drafts written before read **stale**, and so does every draft written before the stamp existed. Cadences and Queue show the badge. A batch send skips a stale row, and Send next or Send asks you to confirm. Regenerate or re-preview to clear it. When a LinkedIn note you reviewed turns stale, the unattended drain drafts it again and holds the new one for your review.
- **No duplicates.** Each campaign send, except through the Smartlead API, carries a key for what it is (workspace, play, recipient, step), not its text. An email confirmed sent is never sent again. One whose outcome is unknown is not resent while it is unresolved. It is retried with the recorded content only if Sent still does not show it 10 minutes after the attempt. SMTP retries reuse the recorded Message-ID; Gmail retries send a new message with a new Message-ID. Where Sent cannot tell, it is flagged for you and not resent.

`sends check --since 7d` lists every keyed send and what the Sent folder showed. Sends through the Smartlead API carry no key, so their copies in Sent are counted and a send that appears twice, or not at all, is flagged.

**A Gmail send cut off at the deadline (#905).** Every Gmail API request has a 30-second deadline covering the whole exchange, headers and body alike, so a hung send is given up on this side long before the five-minute stale-claim demotion and its row is persisted as `failed` or `uncertain` while the claim is still fresh, instead of a `pending` claim ageing into the demotion. The local abort does not end a request Google already received; the persisted row is what the confirm sweep reconciles. What the deadline means for the row depends on where it hit:

- A deadline before the send itself (the profile lookup) is a definite failure: nothing went out, the row is `failed` and may be retried at once.
- A deadline on `/messages/send` is an unknown outcome, not a failure. The request may have reached Google before the abort. The row is `uncertain`, a retry under the same key is refused, and the confirm sweep reconciles it against Sent: a copy there means Google accepted the message, so the row is confirmed and later attempts reuse that result instead of sending again. Only a send the sweep still finds missing after the settle window (`UNCERTAIN_SETTLE_MS`, 10 minutes from the attempt) is settled `failed`, and a retry then resends the recorded content unchanged.

The abort bounds how long this side waits and asks Google to stop; it does not prove Google never processed a request that had already arrived, and a Sent search that finds nothing within a finite window is the policy's evidence of "not sent", not a proof of cancellation. The design accepts that residual window rather than retrying on the deadline alone, which could send a second message under a different Message-ID after a delivered one.

Gmail replies go through the same claim. A reply sent without a request ID is keyed by its text and the message it answers, so the same text in answer to two emails is two replies. The Sent check confirms a reply from a copy to the same recipient with the same subject whose In-Reply-To names the same message. A copy with the subject but no In-Reply-To neither confirms the reply nor lets it be resent: it is flagged for you. When several sends to one person within half an hour match the same way, each is confirmed only if Sent holds a copy for every one of them; otherwise they are flagged for you and not resent. A retry goes to the recipient the first attempt was claimed for, and after an unknown outcome it also stays in the first attempt's thread. The token refresh before a send has the same 30-second deadline, and since nothing was sent, a refresh cut off there is a definite failure.

## Replies

The inbox poll reads the OneShot inbox, every authorised Gmail account and every Smartlead mailbox. A reply stops the cadence whichever identity sent. A reply delayed by an outage is picked up later, not lost, and one you already archived still counts.

Every inbound is classified. Out-of-office notices, dead-mailbox notices and unsubscribes are recorded and never count as replies. The last two suppress the address for good.

An automatic reply is also read for what it says. Rules handle the clear cases; anything they cannot settle goes to one extraction on the workspace's model, which is skipped when no LLM is configured.

- **Left the company** (left, retired, moved on, mailbox closed): the sequence stops as bounced and the address is suppressed. If the reply names someone at the same company domain who is not already a prospect or queued, they are queued on the same play as a pending row for you to review. It is never approved for you.
- **Out of office**: the next step waits until the return date plus 2 days, or 7 days when no date is given. The due time only moves later. Cadences shows "away until Nov 9". A batch send skips the row, and Send next asks you to confirm.
- **Anything else** (ticket receipts, "thanks for your email"): nothing changes.

Set these in the workspace's `config.json`; every key is optional:

```json
"autoReply": { "oooBufferDays": 2, "undatedDelayDays": 7, "queueSuccessor": true, "stopOnBlock": true }
```

`cadence reclassify-auto --since 14d` reads the stored automatic replies and policy blocks of the window again and prints what it would do for each. Add `--write` to do it. It never sends.

A human reply gets one label: `interested`, `question`, `partnership`, `meeting`, `intro`, `not_now`, `objection`, `complaint`, `not_interested`, `wrong_person`, `unsubscribe`, `pitch_back`, `auto_reply` or `other`. Only `unsubscribe` opts the contact out. The label shapes the drafted answer. **Reply labels** on Setup can route labelling to a classifier that also stores a confidence and marks a weak label "check label". `intel backfill-intent` labels older replies; it writes labels and never sends.

Answering from Replies sends from the mailbox that received the message and threads correctly. Drafts are grounded: a known prospect's stored research, an unknown sender's site, and links only from your product brief. A reply whose outcome is unknown is checked against Sent and never resent on its own.

LinkedIn replies stop email cadences too; see [LinkedIn](./linkedin.md).

## Smartlead inboxes

While a workspace's dashboard runs, it syncs each Smartlead mailbox about once a minute. Smartlead keeps doing warm-up. **Replies** shows connection status, last sync and import progress. The first import covers 30 days.

- **Connection settings** is for a mailbox whose IMAP or SMTP credentials Smartlead does not expose. Both are verified before saving, and stored in the workspace's `mailbox-connections.json`, mode 600.
- Mail that matches no prospect sits under **No match**, where you can attach it to one.
- Read, archive and draft state belong to the workspace. They do not change the mailbox.
- Removing an identity stops its sync and keeps its conversations.

## Deliverability

- **Bounces.** Read from connected Gmail mailboxes every 30 minutes. A hard bounce stops the cadence and suppresses the address. A policy block (`5.7.x`) stops the cadence too, since the next step would be refused the same way, but does not suppress the address: it is a verdict on the message, not the mailbox. `autoReply.stopOnBlock: false` keeps blocked cadences running. `doctor` warns above 2% per identity and fails above 5%, once an identity has 20 sends.
- **Inbox placement.** `gmail placement` sends one real message between two of your mailboxes and reports where it landed, with the SPF, DKIM and DMARC verdicts. Run it by hand and rarely; repeated canaries train the receiving filter.

### OneShot domain and address setup

In Setup → Email, choose a domain, mode, and 1–10 comma-separated address local parts. Review the quoted total, billing terms and expiry, then explicitly confirm the purchase. A purchase is immediate and separate from saving configuration. Wait for an active address before adding it as a sender; refresh domain status while provisioning is pending.

Relay is the default for new domains: addresses have no hosted inbox and are not warmed. Hosted mailbox addresses warm individually. Existing domains keep their mode. A blank sender mailbox uses the domain's main address; existing explicitly configured mailboxes remain explicit and must be provisioned.

The CLI exposes the same flow. Replace `REVIEWED_QUOTE_ID` with the quote ID whose terms you accepted:

```sh
oneshot-gtm domains quote example.com --mode relay --addresses agent,sales --json
oneshot-gtm domains buy example.com --quote-id REVIEWED_QUOTE_ID --json
oneshot-gtm domains list
oneshot-gtm identities add
```

For an existing domain, the quote prices additional addresses. An expired quote must be requested and reviewed again. Setup-required or setup-pending responses do not count as sent emails or advance a cadence.

### Unresolved payments

An ambiguous settlement does not mean a lookup found nothing. Payment status and execution status must be reconciled separately: only confirmed non-execution establishes that the operation did not run. A landed payment is credited to the wallet when OneShot confirms the call did not run.

GTM retains a payment hold across processes and restarts, including when a process dies during a guarded call. Accepted jobs that time out or lose their polling connection also stay held, with their request ID retained; they may already have executed. Request deadlines with unknown acceptance retain the submission key when available. An unclassified transport or response-parsing failure also retains the hold because the paid submission may have executed. Explicit SDK refusals and terminal job failures can release it. The held operation is never retried automatically.

Use `oneshot-gtm payments list --json` to inspect the operation and its identifiers. Confirm the execution outcome with OneShot before releasing the hold: a payment credit alone does not make retrying safe. If the operation completed, reconcile that result locally instead of repeating it. Reconciliation notes are stored atomically with the hold resolution in the private shared SQLite database; payment diagnostics contain only the hold key and method. Release for another attempt only after confirming non-execution and reconciling payment. Replace `HOLD_KEY` with the key shown by `payments list`:

```sh
oneshot-gtm payments resolve HOLD_KEY --note "OneShot confirmed non-execution and payment credited"
```

Releasing a hold permits a subsequent attempt; it does not itself purchase or send anything.

If a purchase is confirmed complete but its hold remains (for example, local cleanup failed), verify the domain/address state with `oneshot-gtm domains list` and retain the completed result/receipt locally. Resolve `HOLD_KEY` with a note identifying the completed result; this atomically records the reconciliation and clears the hold. Do not replay the completed purchase. Domain purchases share a hold key across quotes, so clearing a reconciled completed purchase permits a later, separately reviewed address purchase for the same domain.

OneShot replies require a persisted `sendRequestId` for each intended reply. The reply composer supplies it and retains it across edits and retries; both the payment hold and SDK idempotency key use that ID rather than editable message text.

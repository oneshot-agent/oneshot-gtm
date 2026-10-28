# Sending and deliverability

A cap you can talk past is not a cap. A new sender starts at 10 a day, earns 10 more each week, and stops at 50. Once the day's quota is used nothing more sends; the step stays due until midnight.

Mail leaves through a pool of sender identities: OneShot sending domains, your own Gmail or Workspace accounts, and Smartlead-hosted mailboxes, in any mix.

## Adding identities

- **OneShot domain and mailbox.** Setup, or `identities add`. Pick a provisioned domain or type a new one; it is provisioned on first send. `domains list`, `pause` and `resume` manage them.
- **Gmail or Workspace.** `gmail auth`, a one-time OAuth. It needs a Google Cloud Desktop client with the Gmail API on.
- **Smartlead.** `smartlead connect`, or Setup. Smartlead warms and hosts the mailbox. oneshot-gtm sends through the mailbox's own SMTP when its credentials resolve, and through the Smartlead API otherwise. `doctor` names every mailbox still on the API and the command that switches it: `identities send-via <id> smtp`.

`identities test-send <id> --to you@example.com --dry-run` shows what a test would send.

## The rules

- **One sender per person.** Every email to a prospect comes from the identity that sent the first one, across plays and steps.
- **Ramp.** 10 a day, plus 10 a week, to 50. Editable per identity on Setup. Mailboxes on one OneShot domain share one ramp within a workspace, because reputation belongs to the domain. Two workspaces on the same domain each count their own, so give each workspace its own domain. Gmail and Smartlead mailboxes ramp per account, and a Smartlead mailbox never exceeds its own Smartlead limit.
- **Defer, never exceed.** Capacity is reserved before a send starts, so two sends at once cannot both take the last slot. A send whose outcome is unknown still counts toward the cap. At the cap, steps stay due and rows stay approved.
- **One person, one product at a time.** A workspace does not first-touch someone another [workspace](./workspaces.md) emailed in the last 7 days. The draft is flagged `contacted-elsewhere`. Cadences shows the step as held and a batch skips it. You can override on a single manual send.
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

- **Bounces.** Read from connected Gmail mailboxes every 30 minutes. A hard bounce stops the cadence and suppresses the address. A policy block (`5.7.x`) does not: it is a verdict on the message, not the mailbox. `doctor` warns above 2% per identity and fails above 5%, once an identity has 20 sends.
- **Inbox placement.** `gmail placement` sends one real message between two of your mailboxes and reports where it landed, with the SPF, DKIM and DMARC verdicts. Run it by hand and rarely; repeated canaries train the receiving filter.

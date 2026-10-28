# LinkedIn

LinkedIn forgives little, so nothing here sends on a timer. You send each invite and each message, or you run the batch that does.

OneShot holds the account connection and carries out the actions through its API. No browser automation, no webhook to set up. oneshot-gtm decides who to write to, fills in the text from your [templates](#templates) and stops the cadence when someone answers.

One thing runs unattended. Every 30 minutes the server checks pending invites: it records accepts, and withdraws an invite still pending after 21 days.

## Connecting

**Connect LinkedIn** on Setup runs two sign-ins back to back: the messaging account, shared by every workspace, then the [profile-reading session](./finders.md#live-linkedin-reads) for this workspace. **Replies → Connections & reply preferences → LinkedIn** manages the account afterwards.

A new connection asks for `read`, `reply`, `view_profile` and `invite`. An older one adds a missing permission with **Allow profile access** or **Allow connection requests**: you sign in to the same account again and nothing is re-imported.

Conversations are matched to prospects. A human reply stops every live cadence for that person, email included. Auto-responses are recorded and do not count.

## Connection requests as a first touch

A queue row on the LinkedIn channel gets a connection note from the [templates](#templates), filled in from the same signal an email would use. Keep notes under 200 characters, the limit on a free LinkedIn account; Premium allows 300. Review it on Queue, then **Send** it as reviewed, or include the row in a batch.

- **Daily limit.** OneShot enforces the account's invite limit, 25 per UTC day by default, across every tool that uses the account. At the limit the batch stops and the rows stay approved.
- **Workspace share.** `config linkedin-invites <count>` gives this workspace a share of that limit, so the first workspace to send does not spend the day. `off` removes it. The share never raises the account's limit.
- **What is left.** Queue, Cadences and Setup show it: `LinkedIn invites today: 4 of 12 left · account 9 left`.
- **Withdraw.** **Withdraw invite** on the row. It never removes an accepted connection.
- **Switch channel.** An unsent row can move to another channel the person has an address on. Its draft is dropped; Regenerate writes a new one.

A LinkedIn first touch starts a LinkedIn cadence, never an email one.

| Step          | Due                                     |
| ------------- | --------------------------------------- |
| Invite        | when you send it                        |
| First message | 2 days later, and only once accepted    |
| Close         | 6 days after the first message          |
| Withdrawal    | 21 days after the invite, if unanswered |

Each message appears on Cadences as due. You preview it and send it. Until the invite is accepted the preview reads "waiting for acceptance". `not connected` and `rate limited` answers leave the step due; they do not fail it.

**Already connected.** When a profile read from the last 14 days shows the person as a first-degree connection, no connection request is drafted or sent and no invite is used. The row reads "LinkedIn: already connected"; sending it records the connection, and the first message is due on Cadences at once. The read is checked again at send: if it has aged out or no longer shows a connection, nothing is recorded and the connection request is drafted for review instead. If LinkedIn then answers that you are not connected, the step's next preview is the connection request instead, and the message follows its acceptance.

### The invite guard

Before any invite leaves, the row is checked. A refused row is never sent and never dropped: it returns to pending with the reason as its flag. Fix it and send again.

| Reason                    | Means                                                       |
| ------------------------- | ----------------------------------------------------------- |
| `invalid-profile`         | the URL is not a personal `linkedin.com/in/…` profile       |
| `not-a-person`            | the name is a repo, a handle or a company                   |
| `opted-out`               | they unsubscribed                                           |
| `replied`                 | a human reply exists on any channel                         |
| `cadence-stopped`         | you stopped their cadence                                   |
| `icp-rejected`            | the gate rejected them; an unjudged row passes              |
| `already-invited`         | any workspace invited this profile, or is sending to it now |
| `already-touched`         | the profile is on the suppression list                      |
| `already-in-conversation` | the inbox holds a one-to-one conversation with them         |
| `guard-unavailable`       | the guard could not read its data, so it refused            |

### Before you turn on LinkedIn steps

If the account has sent connection requests from another tool or another workspace, tell oneshot-gtm first. The guard sees conversations. It cannot see a profile that was invited and has not answered. Two imports close that gap. Neither sends anything, and running one twice changes nothing.

```bash
oneshot-gtm linkedin import-touched invited.csv [--source <label>] [--dry-run] [--verbose]
oneshot-gtm linkedin import-touched --from-ledgers [--dry-run]
```

The file is a CSV with a `profile_url`, `linkedin_url` or `url` column, or a JSON array of URLs. `--from-ledgers` copies the invites every other workspace on this machine has recorded. **Already contacted on LinkedIn** on the Setup card takes the same file.

## Continuing an email cadence on LinkedIn

Set `linkedinContinuation: true` for the workspace or on one trigger; the trigger wins. For `multiplier` it is on unless the workspace or the trigger sets it to `false`. An email cadence that ends without a reply then carries on three days later:

- an invite whose note knows the person was already emailed,
- a first message once they accept, no sooner than two days after the invite,
- a close.

Someone a recent profile read shows as a connection gets no request: the invite step's preview reads "Already connected: skipping the connection request", and sending it brings the first message forward to now. The read is checked again at send; if it no longer shows a connection, the next preview is the connection request. Someone LinkedIn reports as already connected when the invite goes out has nothing to accept either: their first message goes two days after the invite step. Both messages are written knowing you were already connected, with no thanks for connecting and no mention of a note they never received.

Each step is a draft you review on Cadences. The invite passes the same guard and quota. If the guard refuses, the preview shows the refusal, the step is skipped and the cadence completes. A cadence already running keeps the steps it started with.

A step on a channel the person has no address for is skipped, in any cadence.

## Templates

Every note and message is a template with the person's details filled in. No model writes them, so the same facts always give the same text. Set your own wording on **Setup → LinkedIn copy**; a step you leave blank uses the default.

| Step                                    | Used when                                                             | Default                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection request                      | we know why they surfaced                                             | `Hi {first_name}, saw {evidence}. Would be good to connect.`                                                                                       |
| Connection request, no evidence         | we don't                                                              | `Hi {first_name}, would be good to connect.`                                                                                                       |
| First message                           | they accepted                                                         | `Hi {first_name}, thanks for connecting. What are you working on right now?`                                                                       |
| First message, already connected        | you were connected before the sequence                                | `Hi {first_name}, what are you working on right now?`                                                                                              |
| Last message                            | the prospect has an offer                                             | `Hi {first_name}, last one from me, no reply needed. One thing I'd like to do for you: {offer}. Want me to run a small version? A no is fine too.` |
| Last message, no offer                  | they don't                                                            | `Hi {first_name}, last one from me, no reply needed. If it's ever useful to compare notes, I'm around.`                                            |
| Connection request after an email reply | [they replied by email](#connecting-with-people-who-replied-by-email) | `Hi {first_name}, we traded emails, so connecting here so the next hello isn't cold.`                                                              |

- **`{first_name}`.** Taken from their name. When the name is a handle or a company, the greeting is dropped: `Hi {first_name}, saw …` reads `Saw …`.
- **`{evidence}`.** Why they surfaced, aged as below, as a clause with its subject: `you starred acme/widgets`, `you're in YC F26`, `Acme Ventures led your seed round`.
- **`{offer}`.** The [offer](./prompt-inputs.md#the-prospect-offer) the sequence makes them. The connection requests can't use it: a note that pitches gets declined.
- **A template that can't be filled.** A step whose text needs a value this person doesn't have uses the default for that step.
- **Saving.** Setup refuses an unknown placeholder, or one the step never has, and warns when a template could run past its step's limit.

In `config.json` the templates are `linkedin.templates` (`note`, `noteFallback`, `firstMessage`, `firstMessageConnected`, `lastMessage`, `lastMessageFallback`, `friendNote`). To have the model write each note and message instead, set `linkedin.writer` to `"model"`, or pick **Model** on the Setup card. The rest of this page's rules for drafts apply in that mode.

### What the model is told (`writer: "model"`)

- **Evidence, aged.** One short clause for why the person surfaced. Stale claims are dropped: an event or hiring signal after 45 days, a job change after 90, a stack or funding round after 180. A repo star does not age.
- **Their company.** Named only when the title is a founder's, stored data agrees, and a live read of the profile names it. Otherwise no company is passed.
- **The close.** It says what the product is, names one goal it could carry out for that reader, and ends with an easy out.
- **Lint.** No link and no pitch phrase in the note. The first message holds to 400 characters and one question, with no link and no meeting ask. The close holds to 400 characters with no link, price or unsupported number. A draft that fails gets one repair; what it still breaks shows as a flag and holds the send.

## Connecting with people who replied by email

Invite, message, close is built for strangers. Someone mid-conversation with you by email gets something lighter: **Connect on LinkedIn**, a note that mentions the exchange, and nothing after it.

- **Who qualifies.** At least one email reply labelled `interested`, `question`, `partnership` or `meeting`, not flagged for review. Any reply labelled `unsubscribe`, `wrong_person`, `complaint`, `not_interested`, `objection` or `pitch_back` vetoes it. They must still pass the invite guard; only its email-reply and ICP refusals are lifted for them.
- **Where.** On a qualifying thread in Replies, and on the prospect in Queue and Cadences.
- **How.** The button fills in the note from its template. You edit it and press **Send connection request**. No pitch, no question, no link, no meeting ask, 300 characters at most.
- **After.** No cadence, no scheduled message. If they accept, the conversation continues in Replies.

## Replies

Replies shows LinkedIn conversations beside email. Drafts are grounded in the prospect's research and may link only to pages in your product brief. The composer says so in words when a draft links elsewhere, or when the options say nearly the same thing.

A reply whose payment OneShot refuses is marked not sent, and Send is offered again. It usually means the sending wallet is empty.

What Replies learns from your edits is a proposal you approve; see [learning](./learning.md).

## LinkedIn funnel

**Measure** shows invites sent, pending, accepted and withdrawn, already connected, first messages sent, and replies. It shows the funnel as soon as there is an invite or a known connection in the view. The same numbers come from `oneshot-gtm measure --json` and `GET /api/measure/linkedin` (filters `sinceDays`, `play`, `stepKind`: `first-touch`, `continuation`, `friend`). `oneshot-gtm linkedin invites` lists every invite with its state. All of it is read from this workspace's ledger and inbox. None of it is a number from LinkedIn.

- **Each person once.** A person counts by their newest invite.
- **Accepted.** Counted from the recorded acceptance, else from a one-to-one conversation with the person, else from a first message having gone out. An accept nobody has messaged can be missed, so read the acceptance rate as a floor. "Already connected" is shown apart; people a profile read showed as connected got no invite and are not counted as invites sent.
- **Withdrawn.** `timeout` when oneshot-gtm withdrew it after the wait, `manual` when you did, `unknown` when no cause was recorded.
- **Replies.** Shown two ways: to the first message, and at any point after the invite. The same reply from two sources counts once.
- **Evidence clause.** The funnel splits by whether the note carried an evidence clause.
- **Friend invites.** Invites to people who replied by email are their own row, outside the cold funnel.

## History import

**Import history** downloads every saved conversation, resolves who the senders are, and replays human replies across your workspaces. A historical reply stops that person's cadences, even one that predates enrolment. Running it again duplicates nothing.

A name never establishes identity; only a verified profile does. Unmatched conversations stay visible under their own filter.

The import waits when the day's profile-lookup limit is spent and resumes at the reset. A permission, payment or budget failure stops it for you to review; **Resume** continues where it stopped.

### Remove or replace a connection

**Remove connection** revokes OneShot's access. Imported messages and their prospect assignments stay.

**Force reconnect** is for when Reconnect fails. It disconnects the account and opens a fresh login; sign in as the same LinkedIn member. Both actions cancel pending sends. After a force reconnect, no imported conversation can be replied to until its history is downloaded again, so resume the import and expect a wait.

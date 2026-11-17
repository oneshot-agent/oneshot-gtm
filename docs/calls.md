# Calls

You call prospects yourself, from the dashboard. Nothing here dials unattended and no AI voice talks to anyone. It is off in every workspace until you switch it on.

## Switching it on

**Setup → Calls**, or the CLI:

```sh
oneshot-gtm config calls on
oneshot-gtm config calls step 3 5     # a call at position 3 of new email cadences, 5 days after the touch before it
oneshot-gtm config calls window 09:00-17:00 weekdays
```

| Setting                | Default               | What it does                                                                                       |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `enabled`              | off                   | Shows the Calls page and allows the call step.                                                     |
| `cadenceStep`          | none                  | Puts a call in **new** email cadences. Positions count the first email as 1.                       |
| `cadenceStep.holdDays` | 3                     | Days a due call waits for you before it is skipped and the emails carry on.                        |
| `window`               | 09:00–17:00, weekdays | The prospect's local hours. Outside them the Call button is hidden and the row says when it opens. |

A cadence that is already running keeps its plan: turning calls on never adds a call to it.

## The Calls page

Two lists:

- **Due**: cadences whose next step is a call. A due call with no number shows **Find phone** on the prospect's queue row; the lookup is paid and runs only when you click it. When the cadence reaches a call and no usable number is stored, the step is skipped at once so the emails keep going.
- **Call list**: everyone else with a number, best first: a positive reply with no meeting yet, then people connected on LinkedIn, then people in a live cadence by their priority score, then the rest.

Both lists apply the same gates as sending: the company do-not-contact list, an opt-out on any channel, an ICP reject and a meeting already held. A bounced email does not stop a call.

The local time comes from the number's prefix (libphonenumber's time-zone data). People keep their numbers when they move, so treat it as a hint. A number that could be in several zones must be inside the window in all of them.

## The brief

Opening a row shows a brief: an opener that points back to your email, the offer in one sentence, two or three questions, likely objections with answers, a voicemail of about 20 seconds, and who to ask for at a switchboard. It is written from the same inputs as a follow-up email (the research, the sequence's offer, the emails already sent, your product line and voice card) by your configured model, one paid completion. A due call step's brief is its preview on Cadences; anyone else's is written once and kept until you ask for a new one. Writing flags on the brief warn and never block a call.

## Outcomes

| Outcome                                        | What it does                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| No answer, voicemail, gatekeeper, wrong person | The call step is done; the cadence moves on.                                |
| Wrong number                                   | As above, and the number is cleared and never offered again.                |
| Interested                                     | Counts as a reply: live cadences stop as replied.                           |
| Meeting booked                                 | As interested, and a meeting is recorded.                                   |
| Not now                                        | The step is done and live cadences wait until the date you pick.            |
| Not interested                                 | Counts as a reply; live cadences stop.                                      |
| Do not contact                                 | Every cadence stops and the person is never contacted again on any channel. |

Replies and the funnel count a call the way they count an email reply.

## Your responsibility

OneShot GTM does not check national do-not-call registers, line types or calling-hour laws. Who you call, when, and whether you may record the call is your responsibility.

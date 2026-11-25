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

- **Due**: cadences whose next step is a call. A due call with no number says so and links to the prospect's queue row. The dialler never buys a number itself. When the cadence reaches a call and no usable number is stored, the step is skipped at once so the emails keep going.
- **Call list**: everyone else with a number, best first: a positive latest answer (by email or on a call; a later "not interested" ends it) with no meeting yet, then people connected on LinkedIn, then people in a live cadence by their priority score, then the rest.

Both lists apply the same gates as sending: the company do-not-contact list, an opt-out on any channel, an ICP reject and a meeting already held. A bounced email does not stop a call.

The local time comes from the number's prefix (libphonenumber's time-zone data). People keep their numbers when they move, so treat it as a hint. A number that could be in several zones must be inside the window in all of them; when they never share an hour of it, the row stays outside the window.

## The brief

Opening a row shows a brief: an opener that points back to your email, the offer in one sentence, two or three questions, likely objections with answers, a voicemail of about 20 seconds, and who to ask for at a switchboard. It is written from the same inputs as a follow-up email (the research, the sequence's offer, the emails already sent, your product line and voice card) by your configured model, one paid completion. A due call step's brief is its preview on Cadences; anyone else's is written once and kept until you ask for a new one. Writing flags on the brief warn and never block a call.

## Outcomes

| Outcome                                        | What it does                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| No answer, voicemail, gatekeeper, wrong person | The call step is done; the cadence moves on.                                |
| Wrong number                                   | As above, and the number you dialled is cleared and never offered again.    |
| Interested                                     | Counts as a reply: live cadences stop as replied.                           |
| Meeting booked                                 | As interested, and a meeting is recorded.                                   |
| Not now                                        | The step is done and live cadences wait until the date you pick.            |
| Not interested                                 | Counts as a reply; live cadences stop.                                      |
| Do not contact                                 | Every cadence stops and the person is never contacted again on any channel. |

Replies and the funnel count a call the way they count an email reply. Do not contact is final: a call logged with it cannot be changed to another outcome.

## Ringing your phone (bridged calls)

Without it, Call opens a `tel:` link. With it, Call rings your own phone; when you pick up, it dials the prospect, and they see your number. The call is recorded (by default only once the prospect agrees and you press **Record**, see [Recording consent](#recording-consent)), transcribed with each side labelled, and a suggested outcome is waiting when you hang up.

**Setup:**

1. Add a Twilio API key to the workspace's `.env`:

   ```sh
   TWILIO_ACCOUNT_SID=AC…      # the account or subaccount
   TWILIO_API_KEY_SID=SK…
   TWILIO_API_KEY_SECRET=…
   TWILIO_RING_FROM=+1…        # optional: a number on that account
   ```

   Without `TWILIO_RING_FROM`, your phone is rung from your own number, and some carriers reject that as spoofed (Twilio reports the call as busy within seconds). With it, your phone is rung from that number; the prospect still sees yours.

2. Each member verifies their own phone in **Setup → Calls → Your phone**: type the mobile, press Verify, and type the 6-digit code on the screen when Twilio rings you. Your phone is yours across every workspace on the install; nobody else's Call rings it, and another member cannot add it. Removing it also removes it from Twilio, so using it again needs a new code.

No webhook or tunnel is needed, and a Twilio number only for `TWILIO_RING_FROM`: the server asks Twilio for everything and polls. The transcription service is created on the first transcript and shared by every workspace.

**On every page:** while a call is live, a bar under the header shows who is on it, with whom, how long it has been connected and whether it is being recorded. Your own call has **Open** and **Hang up**. A teammate's call is shown read-only, so you can see who is on a call. After you hang up, the bar keeps your call until its outcome is logged, showing the transcript as it comes (Transcribing…, then Transcript ready). The bar also keeps your call moving: you can leave the Calls page while your phone rings and the prospect is still dialled once you pick up. While your call is connected, the browser tab's title starts with ● On call.

**One call at a time:** you can't call someone a teammate is already on a call with, and you can't start a second call while yours is live. A call that only looks live is checked with Twilio first, so a stale one never blocks you.

**While and after the call:** the dial panel shows ringing you, ringing them, connected, then ended, and one line saying whether the call is recorded: ● Recording, Not recording · ask first, or Not recorded · recording is off. The call time is counted from when it connected, so it reads the same on every page and after a reload. The prospect is dialled once Twilio's answering-machine detection says a person answered your phone and the open dial panel picks that up. If your phone goes to voicemail, the call is hung up and nobody else is dialled. When detection cannot tell (`unknown`), the prospect is dialled anyway, so now and then a voicemail it missed is connected to them; hang up from the panel if you hear one. Just before dialling, the opt-outs and their call hours are checked again: if they no longer allow the call, it hangs up and says why. If no dial panel or sweep reads the call within about 40 seconds of you answering, it hangs up without dialling anyone. After hangup the recording is transcribed (usually within a few minutes) and your configured model proposes an outcome, a note and any promises made. Nothing is logged until you confirm it. If you close the tab, the server finishes the transcript on its own; one still missing after 6 hours is marked failed. Once you confirm the call, your note and the promises you kept go into the next follow-up email, so it picks up from the call.

**Cost per call (Twilio US list prices, October 2026):** two call legs at $0.014/min each, answering-machine detection on your leg at $0.0075 a call, recording at $0.0025/min, transcription at $0.024/min: about $0.28 for a 5-minute call, plus one model completion for the suggestion.

| Setting                          | Default       | What it does                                                             |
| -------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `bridge`                         | on            | `null` in `config.json` turns bridged calls off, even with the keys set. |
| `bridge.record`                  | `ask`         | `oneshot-gtm config calls record ask\|always\|off`. See below.           |
| `bridge.transcriptionServiceSid` | the install's | Use a Twilio Conversational Intelligence service of your own.            |

## Recording consent

Some states and countries require everyone on a call to agree to it being recorded. `record` decides when recording starts:

- **`ask`** (the default, and what an older `true` means): nothing is recorded until you press **They agreed — record** in the dial panel. Once recording, **Stop recording** works the same as below. Ask first ("I record my calls so I can take notes, is that OK?"); the panel shows the line once you're connected. If they say no, don't press it: the call stays unrecorded and has no transcript.
- **`always`**: recording starts when the prospect answers. Use it only where one party's consent is enough. Press **Stop recording** at any time: the call goes on, the part already recorded is kept and transcribed after the call, and **Record** starts it again. To remove what was recorded, press **They didn't agree to recording — delete it** once the call has ended, or **Delete recording** in the call history: the recording, its transcript, the suggestion and the promises read from it are deleted from Twilio and the ledger.
- **`off`**: no recording, transcript or suggestion.

The mode is read when the prospect is dialled; a call keeps what it recorded if the mode changes later. Only the member who placed a call can hang it up or record it; they or an owner can delete its recording from the call history at any time. Twilio's copy is deleted in the background, even with Calls off, and a recording that shows up late is looked for for a week.

## Your responsibility

OneShot GTM does not check national do-not-call registers, line types or calling-hour laws. Who you call, when, and whether you may record the call is your responsibility.

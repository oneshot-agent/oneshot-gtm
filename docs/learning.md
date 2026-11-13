# Learning and approval

The tool proposes. You decide. It records what you send, edit and reject, and nothing it concludes from that reaches a draft until you approve it.

Proposals wait in the **Learning** strip at the top of Queue.

## What it learns

| Proposal           | Learned from                                                              | Approval changes                                   |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Writing preference | your feedback and repeated edits on drafts, on email and LinkedIn         | one guidance line on the channel and stage it fits |
| Reply-based angle  | an angle that clearly got more replies than the play's other angles       | one "lead with" line on that channel and stage     |
| Prospect angle     | one prospect's reply or recorded outcome                                  | that prospect's hook, exclusions and next step     |
| Campaign angles    | what you did with each configured angle, when you ask                     | the play's `yourEdge` angles                       |
| ICP                | queue decisions you tagged with a fit reason, plus meetings and won deals | the ICP one-liner                                  |

A preference is about how you write. An angle is about what to argue. The ICP is about who to write to. They are kept apart.

## Style from your writing, content from replies

Writing preferences learned from your sends are style only: length, structure, tone, register, how a message opens and signs off, and the shape of its question. The drafts you regenerated, next to what you sent, are read for how they are written, never for what they say. A suggestion that tells the writer what to argue ("highlight ...", "propose ...", "pitch ...", "mention that ...", "emphasize ...", "position X as ...", "observe that ...") is dropped before it reaches you. Its evidence line reads "What you sent, next to the drafts you regenerated, across N ...".

What to argue is suggested only when replies back it. Once a day, each play's configured angles are compared per channel and stage (email first touches, email follow-ups, and the same on LinkedIn), counting distinct people. An angle qualifies when all of these hold:

| Rule               | Threshold                                                    |
| ------------------ | ------------------------------------------------------------ |
| People sent it     | at least 30                                                  |
| People who replied | at least 3                                                   |
| Reply rate         | at least double the rate of the play's other angles combined |
| Not chance         | one-sided Fisher exact test, p below 0.1                     |

A qualifying angle becomes one suggestion: "When the research supports it, lead with: <angle>". Its evidence line shows the counts, for example "7 of 61 replied on this angle, against 4 of 212 on the play's other angles". Sends written from a template and angles generated per prospect are not counted. The counts are observational: who got an angle can differ from who got the others.

A reply-based suggestion has its own area per channel and stage, so it and a style suggestion for the same messages can wait side by side. Approved, it applies to that channel and stage like any other preference.

## Reviewing

Each proposal is one row showing only what would change.

- **approve** applies it to drafts from now on.
- **dismiss** drops it. The same evidence will not raise it again, and a later writing preference that mostly repeats its words (most content words shared, same numbers and negations) is skipped.
- Open the row for **was**, **evidence** and **edit**. **edit before approving**, then **approve edited**, applies your wording.
- The history below lists what is applied. **Roll back** restores what was active before. A writing preference can be disabled and enabled again; twelve can be active at once.

Approval is refused when the value moved since the proposal was made, for instance you edited the ICP by hand. Dismiss it and a fresh one follows. An approval never rewrites or sends an existing draft.

## How many wait

One proposal waits per area: a writing preference's channel and stage (LinkedIn follow-ups, email replies), the reply-based slot beside it, or one prospect's angle. A newer one replaces the one waiting.

A proposal you have not decided in 7 days is retired. Set `learning.expireAfterDays` to change that. An angle proposal is also retired once its prospect has no live sequence (active, paused or replied) and no pending or approved queue row. A retired proposal counts as dismissed, so it does not come back.

A writing preference needs 10 new sends in its area since the area's last proposal or decision, and each area gets at most one per run. For the reply-based slot, unattended sends count too.

## What a draft sees

Only approved guidance: enabled preferences for its channel and stage, the prospect's active angle, the active ICP. Your product facts, the [voice card](./voice.md) and what you type in the moment outrank all of it. A preference is never a source of facts, links or promises.

A preference learned from LinkedIn replies applies to LinkedIn replies. It reaches email only when email evidence supports it too.

LinkedIn notes and messages written from templates (`linkedin.writer` unset or `"template"`) read no learned guidance, and a template's text is never evidence of your style. In such a workspace no LinkedIn first-touch or follow-up preference is proposed, style or reply-based, and any waiting is retired. LinkedIn replies still learn.

## The reject box teaches the ICP, sometimes

Rejecting a row on Queue or Prospects asks why, by tapping:

| Reason           | Teaches the ICP |
| ---------------- | --------------- |
| Not our audience | yes             |
| Wrong person     | yes             |
| Bad timing       | no              |
| Already in touch | no              |
| Draft problem    | no              |
| Other            | no              |

The box opens with a suggested reason and a one-line note, taken from the gate's verdict or written by the model from the prospect's own evidence. What you tap wins. The note is yours to edit, 300 characters at most; an emptied box clears it.

Approving teaches nothing by default. Choose **as fit** to count an approval as ICP evidence. A booked meeting, a qualified opportunity and a won deal count as commercial evidence. A lost deal, a polite reply and an unsubscribe never count as success.

The ICP proposal needs 30 tagged decisions (`icpProposalMinDecisions`) and is computed at most once a day.

## Campaign angle suggestions

Under a trigger's edge editor, **Suggest angle changes** reads the counts shown there and recent objections, and proposes which angles to keep, retire or add. Treat it as a hypothesis. The counts are observational: a difference can come from who was offered an angle, not from the angle. Nothing reallocates traffic.

## Limits

Learning runs in the background, under the daily spend ceiling, and never delays a draft or a send. Failed sends, auto-replies and unsubscribes are never evidence. Unattended sends are never evidence of your style; reply-based angles count them, because a reply is the evidence there. A preference needs your explicit feedback on one reply, the same edit across three conversations, a consistent pattern across five, or, for a reply-based angle, the thresholds above. The demo install shows proposals and refuses decisions.

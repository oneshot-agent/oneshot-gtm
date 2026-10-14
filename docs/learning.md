# Learning and approval

The tool proposes. You decide. It records what you send, edit and reject, and nothing it concludes from that reaches a draft until you approve it.

Proposals wait in the **Learning** strip at the top of Queue.

## What it learns

| Proposal           | Learned from                                                              | Approval changes                                   |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Writing preference | your feedback and repeated edits on drafts, on email and LinkedIn         | one guidance line on the channel and stage it fits |
| Prospect angle     | one prospect's reply or recorded outcome                                  | that prospect's hook, exclusions and next step     |
| Campaign angles    | what you did with each configured angle, when you ask                     | the play's `yourEdge` angles                       |
| ICP                | queue decisions you tagged with a fit reason, plus meetings and won deals | the ICP one-liner                                  |

A preference is about how you write. An angle is about what to argue. The ICP is about who to write to. They are kept apart.

## Reviewing

Each proposal is one row showing only what would change.

- **approve** applies it to drafts from now on.
- **dismiss** drops it. The same evidence will not raise it again in other words.
- Open the row for **was**, **evidence** and **edit**. **edit before approving**, then **approve edited**, applies your wording.
- The history below lists what is applied. **Roll back** restores what was active before. A writing preference can be disabled and enabled again; twelve can be active at once.

Approval is refused when the value moved since the proposal was made, for instance you edited the ICP by hand. Dismiss it and a fresh one follows. An approval never rewrites or sends an existing draft.

## What a draft sees

Only approved guidance: enabled preferences for its channel and stage, the prospect's active angle, the active ICP. Your product facts, the [voice card](./voice.md) and what you type in the moment outrank all of it. A preference is never a source of facts, links or promises.

A preference learned from LinkedIn replies applies to LinkedIn replies. It reaches email only when email evidence supports it too.

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

Learning runs in the background, under the daily spend ceiling, and never delays a draft or a send. Failed sends, unattended sends, auto-replies and unsubscribes are never evidence. A preference needs your explicit feedback on one reply, the same edit across three conversations, or a consistent pattern across five. The demo install shows proposals and refuses decisions.

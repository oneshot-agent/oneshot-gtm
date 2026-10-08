# Learning and approval

oneshot-gtm learns from what you send, edit and decide, on email and LinkedIn alike. It never changes how it writes on its own: every learned change is a **proposal** you approve, edit, dismiss or roll back on `/queue`. Recording what happened is automatic; changing behaviour is not.

## What is learned

| Proposal           | Learned from                                                                                                    | What approval changes                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Writing preference | Your explicit feedback and repeated edits on reply drafts; the drafts you regenerated next to the ones you sent | A guidance line added to drafts on the channels and stages it applies to |
| Prospect angle     | A human reply (email or LinkedIn) or a recorded outcome for one prospect                                        | That prospect's hook, exclusions and next step                           |
| Campaign angles    | What you did with each configured angle, plus the objections replies raised, when you ask for it                | The play's `yourEdge` angle set                                          |
| ICP                | Queue decisions you tagged with a fit reason, plus recorded meetings, qualified opportunities and won deals     | The active ICP one-liner                                                 |

Each kind answers a different question and is kept apart: a preference is about how you write, an angle about what to argue, the ICP about who to write to.

## What drafts see

A draft reads only guidance that was approved: enabled writing preferences for its channel (email or LinkedIn) and stage (first touch, follow-up, reply), the prospect's active angle, and the active ICP. Pending, dismissed, disabled and rolled-back proposals are invisible to it. Each draft version records the guidance set it was written with (`learning_key`), so outcomes can be read per guidance the way they are read per voice card. Configured product facts, the voice card and your instructions in the moment always outrank learned guidance, and a preference is never a source of product facts, links or promises.

A preference learned from LinkedIn replies applies to LinkedIn replies unless the evidence also came from email; nothing is generalised across channels or stages without evidence from both.

## Reviewing

The **Learning** card at the top of `/queue` lists everything waiting, by kind. Each proposal shows the current value, the proposed one, the scope (channel and stage, prospect, or play), the evidence it stands on (samples, counts, how the evidence was selected) and a summary. Replies and a prospect's sheet link straight to their own proposals.

- **Approve** applies it to drafts from now on.
- **Edit & approve** applies your wording instead.
- **Dismiss** keeps the same text from coming straight back.
- **Roll back** restores what was active before an approval.
- A writing preference can also be **disabled** and re-enabled; twelve can be active at once.

Approval is refused when the value it would change has moved since the proposal was made (you edited the ICP or the edge by hand, or approved another proposal for the same scope); dismiss it and a fresh one follows. Approving one proposal marks the others for the same scope stale. An approval never rewrites or sends an existing draft.

## Queue decisions and the ICP

Approving or rejecting a queue row can carry a reason: _fit_, _not our audience_, _right company, wrong person_, _bad timing_, _draft problem_ or _other_. Only the first three are fit judgments and only they teach the ICP; a rejection for timing or a weak draft says nothing about who your customer is. A single-row Approve records _fit_; bulk approvals record no reason. Recorded outcomes (meeting booked, qualified, won) are passed to the ICP job separately, as commercial evidence distinct from approval; lost deals, ghosting, polite replies and unsubscribes are never read as success. The ICP job still needs thirty tagged decisions and runs at most once a day.

## Campaign angle suggestions

Under a trigger's edge editor, **Suggest angle changes** reads the counts shown there (offered, rotated away, redrafted, sent, replied, by distinct prospect) and recent objection replies, and proposes which angles to keep, retire or add. The proposal names the selection method (fit classifier or even split) and the sample sizes, and is labelled a hypothesis: the counts are observational, and a difference may come from who was offered an angle rather than the angle itself. Nothing reallocates traffic; the fit classifier and the even split keep running as configured.

## Before approval existed

Preferences learned by the earlier LinkedIn reply learning are moved into the review list once, marked as learned before review existed, with their evidence; they stop applying until approved, and ones you had disabled arrive dismissed. Prospect angles synthesized before this release stay active; only new revisions wait for review. `synthesize-angles` proposes by default and keeps a direct write behind `--apply`.

## Limits and spend

Background learning runs on the scheduler, never on a send or draft path, under the daily spend ceiling and the same leases that stop two processes doing the same work. Reply evidence is read in batches of up to 100 confirmed sends; failed, uncertain and unattended sends, automated replies and unsubscribes are never evidence. A preference needs explicit feedback on one reply, the same edit across three conversations, or a consistent pattern across five; style read from regenerated first touches needs five distinct prospects. The demo install is read-only: proposals render, decisions are refused.

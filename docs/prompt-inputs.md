# What reaches the model, and when

The model knows only what you put in config, and each field reaches some drafts and not others. The field names do not tell you which. This table does.

| What you wrote                                       | First touch              | Follow-up                          | Reply                             |
| ---------------------------------------------------- | ------------------------ | ---------------------------------- | --------------------------------- |
| `founderName`, `productOneLiner`                     | yes                      | yes                                | yes                               |
| `yourEdge`, `yourClaim` (from the trigger)           | yes                      | no                                 | no                                |
| `founderCredentials`, `productPortfolio`, `partners` | yes                      | yes                                | no                                |
| `founderAdmission`                                   | about 1 in 3             | no                                 | no                                |
| `pilotOffer`                                         | no                       | the last step of the builder plays | no                                |
| `icpOneLiner`                                        | no [^icp]                | no                                 | yes                               |
| `productBrief`                                       | no                       | no                                 | yes, and the only source of links |
| `founderVoice`, the [voice card](./voice.md)         | yes                      | yes                                | yes                               |
| Earlier emails on the thread                         | no                       | yes                                | yes                               |
| `founderCohort`                                      | `accelerator-batch` only | no                                 | no                                |
| A meeting outcome and your notes                     | no                       | no                                 | yes                               |
| Approved [learned guidance](./learning.md)           | yes                      | yes                                | yes                               |

[^icp]: `add-prospect`, `profile-intro` and `x-repost-intro` pass it themselves.

Each play adds its own signal on top: the repo they starred, the event they joined, the cohort they launched in. A reply also gets what the ledger knows about the sender: their research, their angle, any meeting outcome and the gate's verdict.

## The shape worth remembering

**The first touch knows your argument and not your product. The reply knows your product and not your argument.** `yourEdge` never reaches a reply. `productBrief` never reaches a first touch.

`productOneLiner` is the only field on all three. Keep it to one sentence. It lands in a one-sentence slot, so the model compresses it and the tail is what gets cut.

Config is source material. No field can force a sentence into an email; every prompt paraphrases what it is given. Put each thing where it has a slot:

| To say                | Use                                                  |
| --------------------- | ---------------------------------------------------- |
| proof                 | `founderCredentials`, `productPortfolio`, `partners` |
| one true concession   | `founderAdmission`                                   |
| the argument          | `yourEdge`                                           |
| facts and links       | `productBrief`                                       |
| who it is for         | `icpOneLiner`                                        |
| what a pilot includes | `pilotOffer`, never a price                          |

`pilotOffer` replaces the plain breakup on the last step of `repo-interest`, `stack-consolidation`, `competitor-switch`, `hiring-signal` and `post-funding`. `accelerator-batch` always ends on the plain breakup.

## Angles

An edge is usually three or four angles separated by `//`. Each prospect gets the one that fits them. One angle works, and draws a lint warning.

- **Writing one.** Open with who it fits, in terms visible on the row: "For a founder selling to clinics". Then a lesson (a named failure and what was learned) or an opportunity (what this reader could do that peers cannot yet, resting on one number or capability). Anything that must appear in every email does not belong in an angle.
- **How one is chosen.** A separate classifier picks the angle whose opening condition is true of the prospect. The choice is saved, so a regenerate makes the same pick. Follow-ups get a different angle from the intro.
- **Lint on save.** A warning, never a refusal: a missing "who it fits" clause, landing-page phrasing, or an outcome promised with no number behind it.

### What the trigger editor shows

Under `yourEdge`, per angle: offered, rotated away, redrafted, sent, replied, counted in distinct people. An angle offered three times or rotated away twice without a send is marked "never sent", with a **Retire** button. A reply rate appears once a line has 30 sends.

Angles go to whoever they fit, so comparing them is a hint, not a test. For a test, set `angleAssignment: "arm"` on the trigger. Each prospect then gets one angle by an even split and keeps it through the follow-ups.

### Editing an edge

Drafting and regenerating read the trigger's current `yourEdge`, including for rows queued before the edit. An existing draft is not rewritten; regenerate it. A sent email never changes.

### Rotate angle

**Rotate angle** on an unsent draft writes a new preview with the next angle, in order, wrapping at the end. If the trigger has only one angle, the first rotation writes one alternative for that prospect. It does not edit the trigger. Rotating never sends.

## First-touch format

`firstTouchFormat` tests the shape of the first email. Unset, nothing changes.

- `standard`: the play's own prompt.
- `brief`: at most three sentences and under 70 words, no opening observation, one ask.
- `split`: each prospect is fixed to one arm. `firstTouchSplit` is the share on `brief`, default 0.5.

A brief draft over the limit gets one tighter redraft, and is held if it is still over. Follow-ups are unchanged. The trigger editor shows results per arm.

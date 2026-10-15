# What reaches the model, and when

The model knows only what you put in config, and each field reaches some drafts and not others. The field names do not tell you which. This table does.

| What you wrote                                       | First touch               | Follow-up                 | Reply                             |
| ---------------------------------------------------- | ------------------------- | ------------------------- | --------------------------------- |
| `founderName`, `productOneLiner`                     | yes                       | yes                       | yes                               |
| `yourEdge`, `yourClaim` (from the trigger)           | yes                       | no                        | no                                |
| `founderCredentials`, `productPortfolio`, `partners` | yes                       | yes                       | no                                |
| `founderAdmission`                                   | about 1 in 3              | no                        | no                                |
| `pilotOffer`                                         | yes, as the offer's terms | yes, as the offer's terms | no                                |
| `icpOneLiner`                                        | no [^icp]                 | no                        | yes                               |
| `productBrief`                                       | yes [^offer]              | yes [^offer]              | yes, and the only source of links |
| `founderVoice`, the [voice card](./voice.md)         | yes                       | yes                       | yes                               |
| Earlier emails on the thread                         | no                        | yes                       | yes                               |
| `founderCohort`                                      | `accelerator-batch` only  | no                        | no                                |
| A meeting outcome and your notes                     | no                        | no                        | yes                               |
| Approved [learned guidance](./learning.md)           | yes                       | yes                       | yes                               |

[^icp]: `add-prospect`, `profile-intro` and `x-repost-intro` pass it themselves.

[^offer]: With the prospect offer, below. Plays that make no offer (`discovery-interview`, `pmf-survey`, `demo-no-show`, `x-amplify`, `community-reply`) do not get it.

Each play adds its own signal on top: the repo they starred, the event they joined, the cohort they launched in. A reply also gets what the ledger knows about the sender: their research, their angle, any meeting outcome and the gate's verdict.

## The shape worth remembering

**Every outreach message opens with an offer specific to this prospect's firm.** `yourEdge` never reaches a reply.

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

## The prospect offer

Most founders sell something. The prospect offer is that offer, made specific to one firm: the outcome your product would deliver there.

After a finder's research, a model works out how the firm makes money, its stage, and what this person owns, then picks the most valuable outcome your product can deliver. It writes it in the firm's own terms, with the steps your product would take. Every message to them opens with it: the first email, each follow-up, the LinkedIn messages, the X DM and the letter. Follow-ups keep the same offer and add one new reason. The last one restates it and closes.

- It needs `productBrief`. The steps may claim only what the brief says your product does. With no brief, no offer is written and each play keeps its own shape.
- `pilotOffer` is the general terms every offer carries: a pilot, a trial, a partnership, a service.
- It is checked before use. Any number must be in the research, any quote must be copied from it, and it cannot borrow your product's own wording, carry a price or a link, or open on an observation about them.
- It shows at the top of the case on `/queue`. **Edit offer** saves your text, which is never rewritten after that. **New offer** writes a fresh one. Either way the draft is rewritten around it.
- With thin research it is written from the role and the kind of firm, and tagged so.
- Plays whose message is not an offer get none: `discovery-interview`, `pmf-survey`, `demo-no-show`, `x-amplify`, `community-reply`. The LinkedIn connection note never makes the offer; it uses the offer's subject as common ground.

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

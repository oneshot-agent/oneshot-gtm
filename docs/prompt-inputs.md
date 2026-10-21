# What reaches the model, and when

The model knows only what you put in config, and each field reaches some drafts and not others. The field names do not tell you which. This table does.

| What you wrote                                       | First touch                 | Follow-up                 | Reply                             |
| ---------------------------------------------------- | --------------------------- | ------------------------- | --------------------------------- |
| `founderName`, `productOneLiner`                     | yes                         | yes                       | yes                               |
| `yourEdge`, `yourClaim` (from the trigger)           | yes                         | no                        | no                                |
| `founderCredentials`, `productPortfolio`, `partners` | yes                         | yes                       | no                                |
| `founderAdmission`                                   | about 1 in 3                | no                        | no                                |
| `pilotOffer`                                         | yes, as the offer's terms   | yes, as the offer's terms | no                                |
| `memberOffer`                                        | `multiplier` only, verbatim | `multiplier` letter only  | no                                |
| `icpOneLiner`                                        | no [^icp]                   | no                        | yes                               |
| `productBrief`                                       | yes [^offer]                | yes [^offer]              | yes, and the only source of links |
| `founderVoice`, the [voice card](./voice.md)         | yes                         | yes                       | yes                               |
| Earlier emails on the thread                         | no                          | yes                       | yes                               |
| `founderCohort`                                      | `accelerator-batch` only    | no                        | no                                |
| A meeting outcome and your notes                     | no                          | no                        | yes                               |
| Approved [learned guidance](./learning.md)           | yes                         | yes                       | yes                               |

[^icp]: `add-prospect`, `profile-intro` and `x-repost-intro` pass it themselves.

[^offer]: With the prospect offer, below. Plays that make no offer (`discovery-interview`, `pmf-survey`, `demo-no-show`, `x-amplify`, `community-reply`, `multiplier`) do not get it.

Each play adds its own signal on top: the repo they starred, the event they joined, the cohort they launched in. A reply also gets what the ledger knows about the sender: their research, their angle, any meeting outcome and the gate's verdict.

## The shape worth remembering

**Every outreach message opens with an offer specific to this prospect's firm.** `yourEdge` never reaches a reply.

`productOneLiner` is the only field on all three. Keep it to one sentence. It lands in a one-sentence slot, so the model compresses it and the tail is what gets cut.

Config is source material. No field can force a sentence into an email; every prompt paraphrases what it is given. Put each thing where it has a slot:

| To say              | Use                                                  |
| ------------------- | ---------------------------------------------------- |
| proof               | `founderCredentials`, `productPortfolio`, `partners` |
| one true concession | `founderAdmission`                                   |
| the argument        | `yourEdge`                                           |
| facts and links     | `productBrief`                                       |
| who it is for       | `icpOneLiner`                                        |
| the offer's terms   | `pilotOffer`, never a price                          |
| what members get    | `memberOffer`, quoted whole by `multiplier`          |

`pilotOffer` replaces the plain breakup on the last step of `repo-interest`, `stack-consolidation`, `competitor-switch`, `hiring-signal` and `post-funding`. `accelerator-batch` always ends on the plain breakup.

`memberOffer` is what an organization's members get when it offers your product to them: credits, setup, an extended trial, in your own words, prices and conditions included. Only `multiplier` reads it. The email quotes it whole, the letter proposes it as its offer and its terms, and the model never writes, shortens or extends it: a draft that does not contain the offer verbatim is held (`multiplier:offer-missing`), nothing rewrites the offer into it, and a price or discount the model adds outside the quoted offer is held too. With it empty the play refuses before any paid call. Set it in `config.json` for the workspace or as `memberOffer` on one trigger; the trigger wins. Example, in a founder's words:

> A two-week GTM sprint for your cohort: a live kickoff, a 30-minute setup for each company, up to $150 in OneShot credit earned as they go ($25 at setup, $50 after their first 100 sends, $75 at their first booked meeting), and a private benchmark at the end showing each company's reply rate and cost per meeting against the anonymized cohort.

## The prospect offer

Most founders sell something. The prospect offer is that offer, made specific to one firm: a job your product would carry to completion there, and what it returns.

After a finder's research, a model works out how the firm makes money, its stage, and what this person owns. It writes five offers, ranked by what each returns to the firm: money in, money not spent, hours back, a risk closed. Each is an execution with an end state, never a standing service: no offer to track, monitor or alert. Each carries the steps your product would take and its return, how the firm would count it. The first is active. Every message to them opens with it: the first email, each follow-up, the LinkedIn messages, the X DM and the letter. The last one restates it and closes.

The active offer also gets five angles: reasons it pays back for this firm. The first message uses one; each follow-up uses another, so every touch brings a new reason behind the same offer. Your `yourEdge` is given to the writer as reasons it may reuse. A row without offer angles uses `yourEdge` as before.

- It needs `productBrief`. The steps may claim only what the brief says your product does. With no brief, no offer is written and each play keeps its own shape.
- With a brief, a first email no offer could be written for is held (`no-offer`), never sent on the terms alone. Regenerate it on `/queue`, or write an offer.
- Every follow-up restates the offer the first email made. An email sent from a typed `/run` list or the CLI keeps a sent row on `/queue` for it, linked to the person.
- `pilotOffer` is the general terms every offer carries: a pilot, a trial, a partnership, a service.
- It is checked before use. Any number must be in the research, any quote must be copied from it, and it cannot borrow your product's own wording, carry a price or a link, open on an observation about them, or lead with watching (track, monitor, keep, ground…). A researched offer needs a return.
- It shows at the top of the case on `/queue`, with its return and its angles under **How and why**. **Other offers** lists the rest; **Use this offer** makes one active and writes its angles. **Edit offer** saves your text and return, which are never rewritten after that. **New offers** writes five fresh ones. Each way the draft is rewritten around it.
- **Next offer** in the queue letter's footer steps through the ranked offers and wraps to the first, rewriting the draft each time. **Offer N of M** beside the angle label shows the active position. Rotation is available with at least two candidates, before sending, and only while the active offer is not your own edit.
- With thin research it is written from the role and the kind of firm, and tagged so.
- Plays whose message is not an offer get none: `discovery-interview`, `pmf-survey`, `demo-no-show`, `x-amplify`, `community-reply`, and `multiplier`, whose offer is `memberOffer` verbatim. The LinkedIn connection note never makes the offer; it uses the offer's subject as common ground.

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

A row whose active offer has angles uses those five in place of the trigger's edge: selection, **Rotate angle** and follow-ups all step through them, and nothing new is written.

## First-touch format

`firstTouchFormat` tests the shape of the first email. Unset, nothing changes.

- `standard`: the play's own prompt.
- `brief`: at most three sentences and under 70 words, no opening observation, one ask.
- `split`: each prospect is fixed to one arm. `firstTouchSplit` is the share on `brief`, default 0.5.

A brief draft over the limit gets one tighter redraft, and is held if it is still over. Follow-ups are unchanged. The trigger editor shows results per arm.

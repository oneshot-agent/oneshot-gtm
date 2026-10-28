# What reaches the model, and when

The model knows only what you put in config, and each field reaches some drafts and not others. The field names do not tell you which. This table does.

| What you wrote                                       | First touch                 | Follow-up                 | Reply                             |
| ---------------------------------------------------- | --------------------------- | ------------------------- | --------------------------------- |
| `founderName`, `productOneLiner`                     | yes                         | yes                       | yes                               |
| `yourEdge`, `yourClaim` (from the trigger)           | yes                         | no                        | no                                |
| `founderCredentials`, `productPortfolio`, `partners` | yes                         | yes                       | no                                |
| `founderAdmission`                                   | about 1 in 3                | no                        | no                                |
| `pilotOffer`                                         | yes, as the offer's terms   | yes, as the offer's terms | no                                |
| `offerExclusions`                                    | the offer's writer, judge   | the offer's writer, judge | no                                |
| `offerAnchor`                                        | the offer's writer, judge   | the offer's writer, judge | no                                |
| `memberOffer`                                        | `multiplier` only, verbatim | `multiplier` letter only  | no                                |
| `icpOneLiner`                                        | no [^icp]                   | no                        | yes                               |
| `productBrief`                                       | yes [^offer]                | yes [^offer]              | yes, and the only source of links |
| `founderVoice`, the [voice card](./voice.md)         | yes                         | yes                       | yes                               |
| `founderGreeting` [^style]                           | yes                         | yes                       | yes                               |
| `subjectCase` [^style]                               | yes                         | yes                       | no (a reply has no subject)       |
| Earlier emails on the thread                         | no                          | yes                       | yes                               |
| `founderCohort`                                      | `accelerator-batch` only    | no                        | no                                |
| A meeting outcome and your notes                     | no                          | no                        | yes                               |
| Approved [learned guidance](./learning.md)           | yes                         | yes                       | yes                               |

[^icp]: `add-prospect`, `profile-intro` and `x-repost-intro` pass it themselves.

[^style]: Only when set to something other than the default (`Hey`, lowercase subjects). See [Greeting and subject case](./voice.md#greeting-and-subject-case).

[^offer]: With the prospect offer, below. Plays that make no offer (`discovery-interview`, `pmf-survey`, `demo-no-show`, `x-amplify`, `community-reply`, `multiplier`) do not get it.

Each play adds its own signal on top: the repo they starred, the event they joined, the cohort they launched in. A reply also gets what the ledger knows about the sender: their research, their angle, any meeting outcome and the gate's verdict.

## The shape worth remembering

**Every outreach message opens with an offer specific to this prospect's firm.** `yourEdge` never reaches a reply.

`productOneLiner` is the only field on all three. Keep it to one sentence. It lands in a one-sentence slot, so the model compresses it and the tail is what gets cut.

Config is source material. No field can force a sentence into an email; every prompt paraphrases what it is given. Put each thing where it has a slot:

| To say                 | Use                                                  |
| ---------------------- | ---------------------------------------------------- |
| proof                  | `founderCredentials`, `productPortfolio`, `partners` |
| one true concession    | `founderAdmission`                                   |
| the argument           | `yourEdge`                                           |
| facts and links        | `productBrief`                                       |
| who it is for          | `icpOneLiner`                                        |
| the offer's terms      | `pilotOffer`, never a price                          |
| never offered          | `offerExclusions`                                    |
| which anchor to prefer | `offerAnchor`                                        |
| what members get       | `memberOffer`, quoted whole by `multiplier`          |

`pilotOffer` replaces the plain breakup on the last step of `repo-interest`, `stack-consolidation`, `competitor-switch`, `hiring-signal` and `post-funding`. `accelerator-batch` always ends on the plain breakup.

`memberOffer` is what an organization's members get when it offers your product to them: credits, setup, an extended trial, in your own words, prices and conditions included. Only `multiplier` reads it. The email quotes it whole, the letter proposes it as its offer and its terms, and the model never writes, shortens or extends it: a draft that does not contain the offer verbatim is held (`multiplier:offer-missing`), nothing rewrites the offer into it, and a price or discount the model adds outside the quoted offer is held too. With it empty the play refuses before any paid call. Set it in `config.json` for the workspace or as `memberOffer` on one trigger; the trigger wins. Example, in a founder's words:

> Six weeks of the Pro plan free for every company in the cohort, a 20-minute onboarding call for each, and a shared Slack channel with our engineers until the programme ends. After that, 30% off the first year for any company that stays.

## The prospect offer

Most founders sell something. The prospect offer is that offer, made specific to one firm: a job your product would carry to completion there, and what it returns.

After a finder's research, a model works out how the firm makes money, its stage, what this person owns, and the firm's most valuable goals this quarter. It writes five offers, ranked by what each returns to the firm: money in, money not spent, something signed, closed, launched or shipped, a risk closed, hours back. Each is a goal leadership would put on its quarterly plan, carried over weeks of work (by machine, with outside parties, or both) to a counted result this person owns or is one step from. Never a standing service (no offer to track, monitor or alert) and never one pass of checking: vetting, screening, scanning or auditing is a step toward the goal, not the offer. A forecast or analysis alone is insight; the offer is the plan changed on it. Hours saved is the return only when nothing bigger is honest. Each carries the steps your product would take and its return, how the firm would count it. The first is active. Every message that makes the offer opens with it: the first email, each follow-up, the X DM and the letter. On LinkedIn the [templates](./linkedin.md#templates) decide: by default only the last message makes it, and the connection note never does. The last one restates it and closes.

The active offer also gets five angles: reasons it pays back for this firm. The first message uses one; each follow-up uses another, so every touch brings a new reason behind the same offer. Your `yourEdge` is given to the writer as reasons it may reuse. A row without offer angles uses `yourEdge` as before.

- It needs `productBrief`. The steps may claim only what the brief says your product does. With no brief, no offer is written and each play keeps its own shape.
- With a brief, a first email no offer could be written for is held (`no-offer`), never sent on the terms alone. Regenerate it on `/queue`, or write an offer.
- Every follow-up restates the offer the first email made. The sequence keeps that offer from the first send, with a link to the queue row it started from; changing it on the `/cadences` card changes the sequence, never the row. A sequence with no offer gets one written at its next preview, from that row's research or, with no row, the person's. An email sent from a typed `/run` list or the CLI keeps a sent row on `/queue` for it, linked to the person.
- `pilotOffer` is the general terms every offer carries: a pilot, a trial, a partnership, a service.
- `offerExclusions` lists kinds of goal you never offer, one plain-language entry each: `["legal work: drafting or reviewing the prospect's own contracts"]`. The writer is told never to write one and the judge rates one `irrelevant`, so it is never used. Adding one rewrites no stored offer. `find rejudge-offers` re-judges unsent rows and moves an excluded active offer to the next one that passes; your approval does not keep it, only your own edited text does. With nothing left that passes it is held, and `--rewrite-all-weak` writes the set again. A sequence keeps the offer it carries; `--list-excluded` lists the ones whose offer is now excluded.
- `offerAnchor` says which anchor to prefer where the research allows a choice. `prefer-product`: the writer leads with a goal of the prospect's own product wherever the research says what that product does, the judge rates a firm-anchored offer `weak` where it plainly did, and the product-anchored offers that pass lead the ranked set. Where the research says nothing about their product, a firm-anchored offer is right and loses nothing. `either` (the default) has no preference. Each offer records which anchor it rests on, the same thing `fit` says in prose. Changing it rewrites no stored offer: `find rejudge-offers` sweeps them, and `--rewrite-all-weak` writes the sets again.
- It is checked before use. Any number must be in the research, any quote must be copied from it, and it cannot borrow your product's own wording, carry a price or a link, open on an observation about them, lead with watching (track, monitor, keep, ground…), or lead with a check (vet, verify, validate, screen, scan, audit, check). A researched offer needs a return.
- It shows at the top of the case on `/queue`, with its return and its angles under **How and why**. **Other offers** lists the rest; **Use this offer** makes one active and writes its angles. **Edit offer** saves your text and return, which are never rewritten after that. **Approve offer** sends one rated a weak fit as it stands; a prompt update never rewrites it. **New offers** writes five fresh ones, each a different job from the ones it replaces. Each way the draft is rewritten around it.
- Each offer is judged before it is kept. One the judge does not pass is replaced once; a weak one only makes up the five, and holds the send until you rewrite it, pick another or approve it. When none of the five passes, the firm's research is read first if the row has none complete, and the writer tries once more: it is shown the rejected offers and what the judge means by weak, and builds each offer on the most specific fact the research holds. The offers that pass then lead. When none does, the set stays held as before.
- **Regenerate draft** reads the firm's research first when the row has none complete (a homepage read alone is not), then writes the offers again from it. A click waits two minutes at most; research that takes longer lands on the row for the next regenerate.
- **Next offer** in the queue letter's footer steps through the ranked offers, skipping ones rated a weak fit while another is not, and wraps to the first, rewriting the draft each time. **Offer N of M** beside the angle label shows the active position. Rotation is available with at least two candidates, before sending, and only while the active offer is not your own edit.
- It reads the row, the person's and the firm's research, their own pages, recent posts and enrichment. A row found on GitHub also gives it the person's profile and their own repositories (`githubEvidence`, up to 3,000 characters), which the judge reads too.
- How someone was found is what they are looking at, not what they own. A repository they starred, an event they joined or a post they reacted to never becomes their project, and an offer that only restates what your product does is rated weak. With nothing known beyond how they were found (no title, no company, no project of their own, no research), no offer is written and the row says why.
- With thin research it is written from the role and the kind of firm, and tagged so.
- Plays whose message is not an offer get none: `discovery-interview`, `pmf-survey`, `demo-no-show`, `x-amplify`, `community-reply`, and `multiplier`, whose offer is `memberOffer` verbatim. The LinkedIn connection note never makes the offer.

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

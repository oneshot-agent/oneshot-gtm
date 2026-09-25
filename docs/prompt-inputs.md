# What reaches the model, and when

Founder-authored config does not all go to the same place. A field set on
/setup may shape a cold email, a follow-up, a reply, or only one play — and
the differences are not guessable from the field names. This page is the map.

It exists because the gaps hide bugs. `job-change` accepted a `yourEdge` for
months while nothing read it: the finder never stamped it, the target had no
field for it, and the play's input block went straight from `PREVIOUS:` to
`DOSSIER:`. Whatever the founder wrote there never left the database, and
nothing surfaced that.

## The shared spine

Every LLM call gets `_humanizer.md` prepended to its system prompt by
`complete()` (`packages/intel/src/client.ts`), for any prompt whose text
references it. The anti-slop rules and the 4-step shape are global, not
per-play — a play does not opt in, it opts _out_ by not mentioning them.

On top of that:

| Founder-authored input                                                | First touch              | Cadence follow-up                         | Reply                                        |
| --------------------------------------------------------------------- | ------------------------ | ----------------------------------------- | -------------------------------------------- |
| `founderName`, `productOneLiner`                                      | yes                      | yes                                       | yes                                          |
| `yourEdge` / `yourClaim` (current trigger config for queued drafts)   | yes                      | no                                        | no                                           |
| Social proof — `founderCredentials` / `productPortfolio` / `partners` | yes                      | yes                                       | no                                           |
| `founderAdmission`                                                    | yes (~1 in 3)            | no                                        | no                                           |
| `icpOneLiner`                                                         | no [^icp]                | no                                        | yes                                          |
| `productBrief`                                                        | no                       | no                                        | yes — and the only permitted source of links |
| `founderVoice` — the [voice card](./voice.md)                         | yes                      | yes (breakup: one flat line, no aphorism) | yes (none in logistics mode)                 |
| Prior emails on the thread                                            | no                       | yes                                       | yes                                          |
| Overused-openers avoid list                                           | no                       | yes                                       | no                                           |
| `founderCohort`                                                       | `accelerator-batch` only | no                                        | no                                           |
| Meeting outcome + founder's pasted notes (issue #578)                 | no                       | no                                        | yes                                          |

[^icp]:
    except `add-prospect`, `profile-intro` and `x-repost-intro`, which
    each inject it themselves.

Beyond that spine every play's own `buildInputBlock` adds its trigger-specific
fields — the repo they starred, the event they signed up for, the cohort they
launched out of.

The reply also receives what the ledger knows about the sender: the stored
dossier, the synthesized angle (`prospects.angle_json`), any recorded meeting
outcome, and the ICP gate's verdict with its reason (`prospects.icp_verdict`).
The gate line carries its own caveat — title-based, decided before the
conversation, outranked by the thread — so a stale reject never reads as an
instruction to disengage. The prompt's claim-grounding rules keep product
statements inside `productBrief` and forbid describing the product in the
sender's vocabulary; the link rule is enforced in code as well
(`link-not-in-brief` in `packages/plays/src/reply.ts`), since a prose rule
alone gets walked past.

## The shape worth remembering

**The first touch knows your argument but not your product. The reply knows
your product but not your argument.** `yourEdge` never reaches a reply;
`productBrief` never reaches a first touch.

That is deliberate — a cold email carries one insight, a reply has to be
factually right and link to real pages — but it has a consequence worth
planning around: **`productOneLiner` is the only founder-authored field
present on all three surfaces.** Anything that must appear in every message
has to at least live there.

It is not enough on its own, though. Config is _source material_, never a
delivery mechanism: every prompt paraphrases and compresses what it is given,
and no config value can force a sentence into an email. Measured on 2026-09-05
against a positioning line placed at the very front of a 31-word
`productOneLiner` — it survived into none of the three surfaces. The first
touch compressed it to the product name and spent the Identity beat on a
credential; the breakup step is capped at two sentences and has no Identity
beat to spend; the reply prompt is told to answer the sender, not to
re-introduce the product. If a specific claim must appear every time, that is
a change to the _prompt_ that owns the beat, not to a config field.

The field is also the wrong place for a paragraph. It lands in the Identity
beat, which is one sentence, so the model compresses it and the tail is what
gets cut. A positioning line placed at the end of a long one-liner will not
survive into the email. Everything else has a field with better placement:
credentials, portfolio and partners for proof, `founderAdmission` for the
concession, `yourEdge` for the argument, `productBrief` for facts and links,
`icpOneLiner` for who it is for.

## Multiple angles

An edge is 3–4 angles separated by `//`; the tool gives each prospect the one
that fits them, and the trigger editor shows how each one did.

**Choosing.** A small isolated classifier call (`packages/plays/src/_angles.ts`)
picks the angle whose opening condition is true of the prospect, judged from
the target's own fields and the research `prepare` assembled. The choice is
cached per (prospect, edge), so a regenerate makes the same pick and pays
nothing; a one-angle edge makes no call. It is done in code because a writing
prompt cannot hold a distribution: left to it, 25 of 30 drafts on one live
play landed on a single angle. Follow-ups get a different angle from the
intro's (`followUpEdgeAngle`), so the second touch carries new material.

**Writing.** Each angle opens with who it fits, in terms visible in the
payload ("For a founder selling to clinics —", "For someone in a marketing
role —"), never the prospect's internal stage or tooling, which nothing can
confirm. Then one of two shapes: a _lesson_ (a named failure, a mechanism,
what was learned) or an _opportunity_ (what this reader could do that their
peers can't yet, resting on one concrete capability or number). Anything
that must appear in every email does not belong in an angle.

**Checking.** Saving a trigger config runs `lintEdge`
(`packages/plays/src/_edge-lint.ts`), which warns but never refuses: a missing
routing clause, landing-page phrasing, banned copy, or an outcome promised
with no number or product term behind it. The same definition lives in
`packages/prompts/strategist-trigger.md` and in every edge-taking trigger's
`configBrief`.

### What the review loop records

Every draft put in front of the founder is a row in `draft_versions`
(`packages/core/src/ledger-drafts.ts`), keyed to its angle by normalized text,
never by index. **Regenerate** closes it as `regenerate` (text rejected, angle
kept), **Rotate angle** as `rotate` (angle rejected), a reviewed send as
`sent`, an unattended drain send as `auto_sent`, and a cadence that stops
with a preview open as `abandoned`. A send later marked `replied` in
`sequence_events` credits the version it was built on (the latest send in its
slot, never twice). The counts are shown, never fed back to the model.

Under `yourEdge`, the trigger editor on /queue shows:

- **drafts**: intro and follow-up totals (sent, regenerated, rotated, auto-sent, replied);
- **voice**: the same, with the voice card on and off (see [voice](./voice.md));
- **first-touch format**: the same per arm, when the trigger sets one;
- **one line per angle**: offered, rotated, redrafted, sent, replied, in distinct people, with "never sent" after two rotations or three offers and a **Retire** button that removes the angle from the editor text.

A reply rate appears only once a line has 30 sends, or 30 people for an
angle line; below that the panel shows how far the sample has to go. Angles go
to whoever they fit, so an angle comparison is a hint; the first-touch split
is the controlled comparison. Earlier drafts per row are at
`GET /api/queue/:id/drafts` and `GET /api/cadences/:id/drafts?play=`.

## First-touch format

`firstTouchFormat` is an opt-in, measured test of the first email's shape;
nothing changes for a trigger that doesn't set it.

- `standard`: the play's own prompt.
- `brief`: adds a binding FORMAT block (`packages/prompts/_format-brief.md`): at
  most 3 sentences and under 70 words, no opening observation about the reader,
  one ask, and a register from `READER SENIORITY` (a coarse read of the title:
  `exec` / `lead` / `individual` / `unknown`).
- `split`: each prospect is fixed to one arm by a salted hash of their email;
  `firstTouchSplit` is the share on `brief` (default 0.5).

The limits are enforced on the output: a brief draft over either budget gets
one tighter redraft, and lint holds it (`too-many-sentences`, `body-too-long`)
if it is still over. Follow-ups are unchanged. Each intro version records its
arm (`draft_versions.format_key`), and nothing switches arms automatically.

## Keeping this page true

Re-derive rather than trusting it:

```
grep -rn "buildInputBlock" packages/plays/src        # first touch, per play
sed -n '/buildFollowUpEmail/,/^}/p' packages/plays/src/_cadence.ts
grep -n "const user = \[" -A 20 packages/plays/src/reply.ts
grep -rn "socialProofBlock\|admissionBlock" packages/plays/src
```

## Edge edits and queued prospects

Queue drafting and regeneration refresh `yourEdge` and `yourClaim` from the
originating trigger immediately before generation, including prospects queued
before the edit. Prospect facts and the original queue payload remain intact.
An explicitly empty or null edge clears the saved edge for that generation.
Missing triggers or absent fields retain the saved value; malformed trigger
configuration fails generation with an error so it can be corrected.
Manual/imported targets without finder provenance keep their supplied edges.

Editing an edge does not rewrite an existing draft or sent email. Regenerate a
draft to use the new edge; sending a saved draft still sends the reviewed text.
Once this behavior is installed, edge edits require no server restart.

## Rotate angle

On an unsent queue draft, **Rotate angle** creates a new preview using the next
configured angle. It cycles in order and wraps after the last. When there are
fewer than twelve available angles, the first rotation fills the pool to twelve with
alternatives grounded in current product positioning and prospect context. Later
clicks cycle through the saved pool without generating more alternatives. Generated alternatives belong to that prospect's draft; they do not
edit trigger configuration. (Retiring an angle from the trigger editor is the
one control that does — see "What the review loop records" above.) A rotate
records the angle it left as rotated away from; a plain Regenerate records
the draft it replaced as regenerated. Follow-up previews on /cadences record
the same way, and a follow-up's draft now carries the angle the selector chose
for it.

The selected angle is shown below the draft and saved with it. **Regenerate**
keeps that selection until product positioning or configured edges change.
Older drafts recover their initial configured choice through the normal selector.
Generation errors leave the existing draft intact. Rotation never sends; it may
incur the usual LLM and research costs. This control is available across queue
plays, including manual DMs; it is not added to run results or inbox replies.

## Reject reason

The reject box on `/queue` and `/prospects` opens prefilled. Two tiers are free:
the person gate's verdict reason when the verdict was _reject_ or _unclear_,
else a machine-negative note (`auto: …`) with its prefix removed. A finder note
without the prefix is provenance ("going to the founders breakfast"), not a
reason, and is never prefilled. Every other row — most approved rows, where the
gate said _pass_ — has the `/queue` modal ask `reject-reason.md` for one
sentence from the ICP one-liner, the play name, the prospect's own evidence
(company, title, bio, event, repo), the stored dossier rendered as facts
(title, summary, the experience history with periods), and, when the row has
no dossier, one bounded company lookup by the address domain (SDK
`enrichCompany`, $0.005: founded year, headcount, funding stage). The prompt
reads company and dossier before the finder's line and is asked to name a
stage mismatch with the fact that shows it. It never sees names, emails or
URLs, may answer null, and its sentence is only a suggestion in the box until
the founder submits. What is submitted is
trimmed, capped at 300 characters, refused if it starts with `auto:` (the
machine-decision marker), and stored on the row as the note the timeline
shows. An emptied box clears an old note. The text is not forwarded to the
ICP filter's few-shot examples — only the decision is (see `_filter.ts`).

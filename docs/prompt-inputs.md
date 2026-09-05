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

| Founder-authored input                                                | First touch              | Cadence follow-up | Reply                                        |
| --------------------------------------------------------------------- | ------------------------ | ----------------- | -------------------------------------------- |
| `founderName`, `productOneLiner`                                      | yes                      | yes               | yes                                          |
| `yourEdge` / `yourClaim` (trigger config, stamped onto the row)       | yes                      | no                | no                                           |
| Social proof — `founderCredentials` / `productPortfolio` / `partners` | yes                      | yes               | no                                           |
| `founderAdmission`                                                    | yes (~1 in 3)            | no                | no                                           |
| `icpOneLiner`                                                         | no [^icp]                | no                | yes                                          |
| `productBrief`                                                        | no                       | no                | yes — and the only permitted source of links |
| Prior emails on the thread                                            | no                       | yes               | yes                                          |
| Overused-openers avoid list                                           | no                       | yes               | no                                           |
| `founderCohort`                                                       | `accelerator-batch` only | no                | no                                           |

[^icp]:
    except `add-prospect`, `profile-intro` and `x-repost-intro`, which
    each inject it themselves.

Beyond that spine every play's own `buildInputBlock` adds its trigger-specific
fields — the repo they starred, the event they signed up for, the cohort they
launched out of.

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

`yourEdge` may hold several angles separated by `//`. Every angle is sent to
the model on every call — `//` is not a visibility switch. The rule is on the
output: the email is 4-6 sentences, and `_humanizer.md` forbids blending, so
the model picks the one angle that fits this prospect and writes from it
alone. An angle that never fits is never used; that is the model working, not
failing. If something must appear in every email, an angle is the wrong home
for it.

## Keeping this page true

Re-derive rather than trusting it:

```
grep -rn "buildInputBlock" packages/plays/src        # first touch, per play
sed -n '/buildFollowUpEmail/,/^}/p' packages/plays/src/_cadence.ts
grep -n "const user = \[" -A 20 packages/plays/src/reply.ts
grep -rn "socialProofBlock\|admissionBlock" packages/plays/src
```

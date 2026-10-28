# Voice

The model writes like the model until you show it how you write. The voice card is that showing: a short plain-text description of your register, read by every draft.

It lives in config as `founderVoice` and is edited on Setup. Email first touches, follow-ups and breakups carry it, and so do X DMs, community replies and inbox replies. LinkedIn notes and messages carry it only when the model writes them (`linkedin.writer: "model"`); otherwise they are your [templates](./linkedin.md#templates), already in your voice. SMS and letters do not. A blank card adds nothing.

## What the card is

Four headings, a few lines each, at most 1500 characters:

- **MOVES.** Three to five moves you make, described mechanically: "a concrete fact, then the mechanism under it, then one flat line that closes it". Not topics. Topics are not voice.
- **SENTENCES.** Length, punctuation, case, how you cut paragraphs.
- **NEVER.** What you avoid that drafts do not already forbid: pleasantries, flattery, moralising, faking certainty, urgency.
- **EXEMPLARS.** Three to six short lines copied verbatim from your own writing, chosen for rhythm. A number belongs there only if it was in the original.

Every draft already strips em dashes, three-item lists, "X isn't A, it's B", exclamation marks, emoji, hedges and hype words. Greetings and sign-offs are set by the draft rules. None of these belong on the card.

## What the card cannot override

The card sets warmth, bluntness, rhythm and register. Facts, audience, channel limits and the lint still hold.

- One aphoristic line per email at most, never in the ask. A breakup gets none. A reply about logistics gets none.
- Numbers come from the inputs, never invented for effect.
- The register applies to body prose. The greeting, names, the product name and the signature stay as given.
- An asymmetry is a plain statement ("the hard part is X"), never "X isn't A, it's B". The lint flags that shape however much it sounds like you.

## Greeting and subject case

Two config settings change the draft rules' defaults. Unset, drafts are as before. Both reach the drafts that carry the card, with or without a card.

- `founderGreeting`: the word a draft greets with when it greets. Unset: `Hey`. `"Hi"` gives "Hi," or "Hi Sam,"; `"none"` means no greeting.
- `subjectCase`: unset or `"lowercase"`: the whole subject lowercased, acronyms included, and a subject with two capitals in a row (`API`, `URGENT`) is held and rewritten; a single capital (`Hello Sam`) passes. `"sentence"`: sentence case. `"as-written"`: no case rule. Either of those two turns the hold off.

Each draft records which card it was written with. The trigger editor splits sent, regenerated and rotated counts into **voice on** and **voice off**. Judge the card by that split after a week.

## Writing one by hand

Ten minutes. Open six things you wrote and were happy with, ideally messages to strangers. Answer the four headings from them, not from how you would like to write. If a line under MOVES could describe most people, delete it. Paste it on Setup, save, regenerate two queued rows and read them aloud.

## Drafting one from your own writing

```
oneshot-gtm config voice --from ~/writing/posts --messages ~/writing/sent --guide ~/writing/how-i-write.md
```

- `--from`: files or folders of `.md` or `.txt` posts.
- `--messages`: messages you sent to people. They outrank posts, because writing to a stranger is what the card is for.
- `--guide`: a note you wrote about your own style.

It reads plain text files and knows nothing about any notes app. It shows the card and asks before saving. Too little writing produces a sketch, which it will not save without `--yes`. `config voice` alone shows the stored card; `--clear` removes it.

## A worked example

One founder's card, derived from their posts and messages and then edited. It shows the shape. Yours should not read like this unless you do.

```
MOVES
- open on the thing I noticed in their setup, then what it costs them, then stop
- one worked number from their side of the table, never mine
- name the trade-off I chose and the one I did not
- admit the rough edge before they find it
- end on a question they can answer in one line

SENTENCES
- plain declaratives, ten to fourteen words; a fragment only to close
- lowercase except names and acronyms; no bold, no caps for emphasis
- commas and full stops; parentheses for the aside an engineer would want
- paragraphs of two sentences, three at most

NEVER
- a compliment about their company before I have said anything useful
- a feature list; one capability, the one that fits what I saw
- urgency, scarcity, "quick call"
- guessing at their numbers; I ask instead

EXEMPLARS
- the migration took a weekend. the rollback plan took a month.
- we cut the nightly job from forty minutes to six. nobody noticed, which was the point.
- i would rather ship the boring version first.
- how are you handling retries when the upstream API times out?
```

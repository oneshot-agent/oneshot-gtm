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
- a concrete fact first, the mechanism under it second, one flat line that closes it
- say what something is not, then stop; no "but rather"
- one long build, then a short blunt sentence that lands the point
- confess what I don't know instead of faking certainty; it lands harder
- the aphorism is earned by the mechanism above it, never the opener

SENTENCES
- short declaratives, average eight words; a long one only to set up a short one
- lowercase body; a single word in caps for emphasis, rarely
- commas and periods; semicolons in the essayistic line
- paragraphs of one to three sentences

NEVER
- a moral about whether something is good or bad; observe the mechanism instead
- pleasantries, sign-offs, flattery about the reader's company
- faking certainty; when unsure, say so and stop
- a promise of a doc, a deck, a call; the email is the whole offer

EXEMPLARS
- cost is not friction. cost is information.
- the dashboard was always a crutch. the crutch is being removed.
- we're using it in production. it works.
- does this match how you actually measure spend on inference and tools?
```

# Voice

The drafts follow a fixed structure (the humanizer's beats, the anti-slop rules, the lint) so they never read as a template or as a model. What they cannot know is how _you_ write. The voice card fills that gap: a short, plain-text description of your own register that every email draft reads at runtime.

It lives in config as `founderVoice`, edited on `/setup` (Voice) and injected as a `VOICE` block into first-touch emails (and their regenerate/rotate), cadence follow-ups and breakups, breakup-revive, and inbox replies. SMS, letters and X DMs do not carry it. Blank means no block: an install without a card drafts exactly as before.

## What the card is

Four headings, a few lines each, at most 1500 characters:

- **MOVES** — three to five rhetorical moves you actually make, described mechanically ("a concrete fact, then the mechanism under it, then one flat line that closes it"). Not topics; topics are not voice.
- **SENTENCES** — length pattern, punctuation habits, case, how you cut paragraphs.
- **NEVER** — what you avoid that the drafts do not already forbid: pleasantries, flattery, moralising, faking certainty, listicle hooks, urgency. Em dashes, three-item lists, "X isn't A, it's B", exclamation marks, emoji, hedging and hype vocabulary are already stripped from every draft, so they do not belong here; if your samples lean on one of them, the derivation says so once in its notes instead.
- **EXEMPLARS** — three to six short lines copied verbatim from your own writing, chosen for cadence, not content. A number belongs there only if it was in the original.

## What the block enforces around it

The card shapes sentence texture; it does not get to override the prompt. The `VOICE` block carries a budget line the model has to obey, and the lint holds the draft regardless:

- at most **one** aphoristic or deflating line per email, never in the ask; a breakup gets none, only a flat closing line; a reply in logistics mode (scheduling, unsubscribe, a plain yes) gets none;
- numbers only from the inputs, never invented for effect;
- the register applies to body prose only: the greeting, proper nouns, the product name and the signature stay as given;
- an asymmetry is stated as a plain declarative ("the hard part is X"), never as "X isn't A, it's B" — that inversion is the banned "negative parallelism" shape the lint flags, however on-brand it feels. The same goes for three-item lists and em dashes.

Every draft version records which card (a short hash) it was written with, so the trigger editor's usage line splits sent, regenerated and rotated counts into **voice on** and **voice off**. Judge the card by that split after a week of review, and by whether the lint flags on voiced drafts rose.

## Writing one by hand

Ten minutes. Open six things you wrote and were happy with, ideally messages to strangers, and answer the four headings from them, not from how you would like to write. If a line under MOVES could describe most people, delete it. If an exemplar contains a number, check the number is real. Paste it on `/setup`, save, regenerate two queued rows, read them aloud.

## Drafting one from your own writing

The CLI can draft the card from local files:

```
oneshot-gtm config voice --from ~/writing/posts --messages ~/writing/sent --guide ~/writing/how-i-write.md
```

`--from` takes files or folders of `.md`/`.txt` posts. A leading `---` frontmatter block is read for `status:` and `style:` (posts marked posted or published rank first) and stripped. `--messages` takes files or folders of messages you actually sent to people, as fenced code blocks or whole files; they outrank posts, because how you write to a stranger is what the card is for. `--guide` is a note you wrote about your own style, passed as evidence. The reader knows nothing about any notes app or folder layout; it reads plain text files. The prompt (`packages/prompts/voice-derive.md`) is told to describe patterns, never to name an influence, to copy exemplars verbatim, and to carry any inversion habit only in the allowed forms. It shows the card and asks before saving; a thin corpus produces a sketch and refuses to save without `--yes`. `config voice` alone shows the stored card; `--clear` removes it.

## A worked example

One founder's card, as derived from their posts and approved messages and then edited. It is an example of the shape, not a default: your card should not read like this unless you do.

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

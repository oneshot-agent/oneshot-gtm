You write a SHORT PING follow-up to a job-change outbound that has NOT been replied to. Sent ~5 days after the first email — they're a few days deeper into the new role.

[See _humanizer.md — binding. Short pings only.]

[See _offer-first.md — binding when the input has an OFFER line.]

## Context you receive

- Founder name + product one-liner
- Prospect name, new role, new company
- PRIOR EMAILS: the touches you already sent. Use to AVOID recycling.
- OFFER, HOW (optional): the offer the first message made, and how the product delivers it. When present, the OFFER mode below governs this touch.
- OFFER TERMS, PRODUCT BRIEF (optional): the founder's general terms (never a price) and the only source of product claims.

## With an OFFER line

- Restate the same offer in a clause and add one new thing: a HOW step, a credential, or a why-now fact. Never a new offer, never a recap of the first email.
- Body: ≤ 45 words, 1-2 sentences (OFFER mode only), ending on one question about taking the offer.
- The subject rules and the Forbidden list below still apply.

## Email rules (without an OFFER line)

- Subject: 1-3 lowercase words. Examples: "ping", "the new role", "still settling in?".
- Body: ≤ 30 words, 1-2 sentences.
  - One sentence pinging the TOPIC you raised in the first email — NOT a doc you'd send. Pull the concrete topic from PRIOR EMAILS (whatever the first email actually named) and re-ask it. Vary the opener — see _humanizer.md → Opener variety. The lines below are SHAPES, not strings: do not open two sends with the same three words, and do not lead every send with the same stem. Shapes:
    - lead with the concrete noun: "the {topic} — what's actually the bottleneck so far?"
    - ask it flat: "did the {new-role} ramp turn out to be the hard part, or something else?"
    - put it to them: "how much of the month is that eating?"
    NEVER a meeting ask of any kind, and NEVER name an artifact you would send (a doc, sketch, guide, teardown, benchmark, checklist) — see _humanizer.md → Banned CTAs and Banned: invented artifacts. No recap.
  - Sign-off: founder name.
- Forbidden: "following up", "circling back", "bumping this", "wanted to make sure", any "compare notes / swap takes / back-and-forth" ask.

Output as a JSON object only: { "subject": string, "body": string }.

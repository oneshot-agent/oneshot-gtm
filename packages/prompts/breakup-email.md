You write the BREAKUP — the final touch in a sequence after the prospect went silent. Pattern-interrupt, short, low-ask. Breakups are among the highest-reply-rate touches; the trick is that the founder ACTUALLY lets it go after this.

[See _humanizer.md — binding. Breakups are a known anti-pattern surface where AI tells get caught. NO typos in breakups (proof-of-human typos are skipped for terminal emails).]

[See _offer-first.md — binding when the input has an OFFER line.]

## Context

- Founder name + product one-liner
- Prospect name + company
- The play that brought them in (reference the trigger context IMPLICITLY, not explicitly)
- PRIOR EMAILS: the touches you already sent on this play. Use to AVOID recycling.
- OFFER, RETURN, HOW (optional): the offer this sequence carries, what they get back when it is done, and how the product delivers it. When present, the OFFER mode below governs this touch.
- YOUR EDGE (optional): this touch's angle, the reason the job pays back that no earlier email made.
- OFFER TERMS, PRODUCT BRIEF (optional): the founder's general terms (never a price) and the only source of product claims.

## With an OFFER line

This is the last touch: open on the same offer, restated once, then give the reason it pays back, then close.

- Body: ≤ 50 words, 3 sentences.
  - Sentence 1 restates the OFFER in their terms: the job carried to its end state for their firm (never a new one, never a recap of the earlier emails). OFFER TERMS may appear only as a clause, never as the offer itself.
  - Sentence 2 is this touch's angle (YOUR EDGE; RETURN when there is none) stated as what they get back, in their terms, and how they would count it. Never a sentence on how the product works or its plumbing: at most one HOW step, as a clause.
  - Sentence 3 makes "not now" easy and final, in a short question or one plain line. No guilt, no apology, and never an opener announcing that you are stopping.
- Subject: the rule below; with an OFFER line, name that offer.
- The Forbidden list below still applies.

## Email rules (without an OFFER line: plays that make no offer)

- Subject: 2-5 lowercase words naming the offer (or their work) in their terms, the same rule as the first email: this email starts a new thread, so its subject is read on its own. Never a sign-off ("last note", "closing the loop", "moving on", "closing out", "following up") and never a subject PRIOR EMAILS used. NEVER "permission to close your file?" — that's the cliché everyone copies.
- Body: ≤ 50 words, 2 sentences max.
  - Hook (1 sentence): the specific thing for them, their work or the problem the earlier emails named, in their terms. Never an announcement that you are stopping; direct, no apology.
  - Probe-as-CTA (1 sentence): ONE specific yes/no question that makes "not now" an easy answer (a "would love to know if X is the blocker" probe) OR a single offer of value with NO follow-up commitment. Do not repeat any sentence, angle, hook, opener, or close from PRIOR EMAILS below.
  - Sign-off: founder name.
- Forbidden: "did I miss something?", "should I close your file?", "permission to close", "if I don't hear back", "I won't bother you again", "hate to be a pest", "obviously you're busy", any sentence announcing that the sequence is ending ("moving on", "closing your file", "closing the loop", "last note", "one last", "final note", "so your inbox stays clean").

Output as a JSON object only: { "subject": string, "body": string }.

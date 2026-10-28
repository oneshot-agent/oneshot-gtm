You write a short email to the OWNER of a small owner-run business (BUSINESS TYPE). NOT a founder. The close here is the owner-run-business version of a pilot: you set the whole thing up for them, at no cost, and they keep using it only if it actually helps. Plain language throughout — never call this a "design partner" arrangement, a "pilot program", or an "LOI". It is: try it free, keep it if it works.

[See _humanizer.md — binding. Use the flexible first-touch structure from _humanizer.md, but keep every beat shorter and plainer than a founder-to-founder email — this reader skims on their phone between customers.]
[See _offer-first.md — binding when the input has an OFFER line.]

## Banned terms (never use, in any form or rewording)

"design partner", "pilot program", "pilot cohort", "LOI", "letter of intent", "beta program", "early access program", "co-develop", "partnership", "onboarding flow", "implementation", "integration", "platform", "solution", "leverage", "streamline", "ecosystem", any SaaS-category jargon. This is not a corporate pilot; it is a free, no-obligation setup they can walk away from.

## Inputs

- Founder name and product one-liner
- PROSPECT: name, business name
- BUSINESS TYPE: what kind of business this is
- YOUR EDGE: the concrete, specific thing you set up for them and what it does for their day-to-day, in hours or dollars terms — plain English, no feature list
- Optional dossier with extra context
- SOCIAL PROOF (only when set): structured block with CREDENTIALS / PORTFOLIO / PARTNERS lines
- ADMISSION (only when set — the tool supplies it on roughly a third of emails): one true concession about the sender. See _humanizer.md → Optional damaging admission.
- OFFER (optional): the prospect offer, what you offer to do for them.
- HOW (optional): how the product delivers the offer.
- OFFER TERMS (optional): the founder's general terms.
- PRODUCT BRIEF (optional): the only source of product claims.

The free, no-obligation setup is this play's own offer, so _humanizer.md's ban on free trials and cold incentives does not apply to it. Say its terms as OFFER TERMS (or, without them, YOUR EDGE) give them, in this play's plain words; the ban still applies to anything else: no discount, credit or extra sweetener.

## Email rules

With an OFFER line, the offer-first rules set the opening and order: the offer is the free setup applied to the OFFER, and this play's signal becomes the optional why-now clause. Without one, follow the shape below. Either way the Banned terms above hold, even if OFFER TERMS use them: say "set it up free", never "pilot".

- Subject: 2-5 lowercase words, plain English. Examples: "set it up free for {business name}", "no cost to try", "free setup, your call after". NEVER "revolutionize your business" energy.
- Body: 4-6 short sentences, under 90 words — a hard cap. Concrete, plain, in hours and dollars — never abstract value claims.
  - Hook (1-2 sentences): the specific, concrete thing about their business that made you write — a fact from BUSINESS TYPE or the dossier, stated plainly, not a flattery line.
  - Identity (1 sentence): who you are and what you do, in plain words. If SOCIAL PROOF is present, weave ONE concrete, plain-English fact. If ADMISSION is present it replaces this clause (see _humanizer.md).
  - Offer (1-2 sentences): the free setup itself, stated plainly and concretely from YOUR EDGE — what you do, what it saves them (hours, phone calls, missed jobs — whatever is concrete), and its terms as OFFER TERMS give them, in plain words: a length, a scope or a condition they state may be said, but never a price or cost figure, even when OFFER TERMS contain one (see Forbidden below). Without OFFER TERMS, say only that the setup costs nothing and they keep it only if it actually helps, nothing more specific. Never use the word "pilot", "partner", or "program". Say it the way you would say it out loud to the owner in person.
  - CTA (1 short sentence): one plain yes/no question — "want me to set it up for you this week?", "should I set it up for you?". NEVER two time slots, NEVER a calendar link.
  - Sign-off: founder name.
- Forbidden: every term in Banned terms above; also "quick question" as an opener, "I noticed", "reaching out because", "our platform", "our solution", any comma-series of features, "game-changer", "cutting-edge", any explicit price or cost figure (the whole point is that it is free — do not quantify what it "would normally cost").

## Voice

A founder writing plainly to a busy owner. No corporate language, no startup jargon, no design-partner formality. Say the free-and-no-obligation part plainly, once, and move on.

Output as a JSON object only: { "subject": string, "body": string }.

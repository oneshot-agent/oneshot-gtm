You write a short email to the owner of a brand-new small owner-run business — their business licence, contractor licence, or operating authority was issued in the last few weeks. This is a GREENFIELD play: there is nothing installed for them to rip out, so the angle is "be the tool you start on", not a switch pitch or a comparison to anything they use today. NOT a founder — a busy owner-operator setting up a new business (BUSINESS TYPE).

[See _humanizer.md — binding. Use the flexible first-touch structure from _humanizer.md, kept short and plain for a non-technical reader who just started a business and has a hundred other things to set up.]
[See _offer-first.md — binding when the input has an OFFER line.]

## Inputs

- Founder name and product one-liner
- PROSPECT: name, business name
- BUSINESS TYPE: what kind of business this is
- LICENSE/AUTHORITY: what was recently issued and roughly when (e.g. "food service permit, issued 3 weeks ago", "contractor licence, issued this month", "motor carrier authority, granted last week")
- YOUR EDGE: the concrete thing that helps a business at this exact starting point — plain English, in hours or dollars, never a feature list
- Optional dossier with extra context
- SOCIAL PROOF (only when set): structured block with CREDENTIALS / PORTFOLIO / PARTNERS lines
- ADMISSION (only when set — the tool supplies it on roughly a third of emails): one true concession about the sender. See _humanizer.md → Optional damaging admission.
- OFFER (optional): the prospect offer, what you offer to do for them.
- HOW (optional): how the product delivers the offer.
- OFFER TERMS (optional): the founder's general terms.
- PRODUCT BRIEF (optional): the only source of product claims.

## Email rules

With an OFFER line, the offer-first rules set the opening and order, and this play's signal becomes the optional why-now clause: the new licence or authority is that clause, never the opener, and no congratulation. Without one, follow the shape below. Plain words and the Forbidden list hold either way.

- Subject: 2-5 lowercase words, plain English. Examples: "starting {business name} off right", "for the new shop", "before you open". NEVER a pitch-shaped subject.
- Body: 4-6 short sentences, under 90 words — a hard cap. The beats below are flexible ingredients, not a fixed sequence; combine the Hook and Offer and place Identity where it fits naturally.
  - Hook (1-2 sentences): the specific, recent fact from LICENSE/AUTHORITY, said plainly and warmly (not gushing) — this is how you found them and why you're writing now. "Saw {business name} just got its {license/authority}" is fine here because the recency itself IS the hook, unlike a star on a repo — it is a real, timely, congratulatory fact, not a weak signal to over-read.
  - Identity (1 sentence): who you are, plain words. If SOCIAL PROOF is present, weave ONE concrete, plain fact. If ADMISSION is present it replaces this clause (see _humanizer.md).
  - Offer (1-2 sentences): frame it as "start on this instead of bolting something on later" — the concrete thing from YOUR EDGE, stated as a fact about what it saves or avoids for a brand-new operation, not a feature list and not a comparison to any named competitor (they likely have nothing installed yet, so there is nothing to compare against).
  - CTA (1 short sentence): one plain yes/no question inviting a reply — "want me to set it up before you open?", "should I set it up before things get busy?". NEVER two time slots, NEVER a calendar link.
  - Sign-off: founder name.
- Forbidden: "I noticed" as an opener (the licence/authority fact stands in for it and must be specific, not "I noticed your business"), "reaching out because", "our platform", "our solution", "streamline", "leverage", any comma-series of features, "game-changer", "cutting-edge", any explicit price figure, any mention of "switching" or "replacing" anything (there is nothing to replace — this is greenfield), "design partner", "pilot program", "LOI".

## Voice

A founder writing plainly to a busy owner: brief, glad a new business exists, not a vendor. Plain language, no jargon, no startup-speak.

Output as a JSON object only: { "subject": string, "body": string }.

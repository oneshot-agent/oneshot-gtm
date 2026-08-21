You are condensing a founder's product sources (landing page, GitHub README, docs pages) into a PRODUCT BRIEF — the grounding document their email replies will cite when a prospect asks something substantive.

You receive one or more SOURCE sections, each a page's markdown with its URL.

## What to extract

- Concrete facts about what the product does and how it works — architecture, protocols, integration model, settlement/pricing model. Specifics ("settled per call in USDC on Base") over marketing claims ("seamless payments").
- The pricing/billing model, if stated.
- Canonical links: docs pages, the repo, pricing — copied VERBATIM from the sources. Never construct, guess, shorten or "clean up" a URL. If a fact has a source page, put its URL on the same line after " — ".
- Named integrations, protocols and standards (e.g. x402, USDC, OpenTelemetry) with one line of what the product's relationship to each actually is.

## Rules

- Plain text. Short lines, one fact per line, grouped under 2-4 unadorned headings (e.g. "How it works", "Pricing", "Links").
- 150-350 words. This is a reference card, not a brochure.
- No marketing adjectives, no superlatives, no "best-in-class". If the sources only offer slogans for some area, leave that area out.
- Include ONLY what the sources state. No inference, no filler.

Output the brief as plain text only — no JSON, no code fences.

Write a short founder-to-founder note to someone who starred a public repo related to the sender's work. A star explains how you found them; it does not establish that they use the tool, build in this space, or have a particular problem. This is the first of two touches.

[See _humanizer.md — binding factual constraints and flexible first-touch ingredients.]

The configured VOICE card controls tone, greeting preference and rhythm. Do not turn these ingredients into separate mandatory paragraphs.

## Inputs

- FOUNDER and PRODUCT: sender identity and what they actually build.
- PROSPECT, STARRED REPO and optional dossier: known recipient context.
- YOUR EDGE: the selected, grounded reason to write. Use this angle only.
- WHY THIS REPO IS NOTABLE, when present: a supported detail about the tool, not evidence of the prospect's usage or pain.
- CANDIDATE REPOS, when present: optional public work. Mention at most one clearly relevant repo; do not invent its purpose or production use.
- SOCIAL PROOF, when present: at most one relevant supplied fact. Omit when absent.
- ADMISSION, when present: only the supplied concession, replacing rather than adding to social proof. Never invent an incident or personal experience.

## Email rules

- Subject: 2-4 lowercase words, specific and factual. No hype or unsubstantiated problem claim.
- Body: under 100 words. No fixed sentence count or mandatory hook/identity/offer sequence. One clear thought is enough.
- Open with a supported observation or concrete fact about the sender's work that makes the connection worth explaining. Do not open with the star, canned praise, a product-page recap, or a sweeping claim about what always breaks or where work usually stalls. When recipient context is thin, state the sender capability directly rather than inventing a generic industry bottleneck.
- Disclose the source once, briefly: found them through the named repo's stargazers. Place it wherever it fits after the opening. Do not invent when the star happened.
- Name the sender's product once and explain the relevant substance from YOUR EDGE directly. Identity and offer may share a sentence. A concrete capability is sufficient when the inputs contain no lesson or incident; do not manufacture a war story to make it sound insightful. Do not list unrelated features or promise an artifact that is not supplied.
- Sometimes close with one short, natural question that helps establish interest or relevance and is easy to answer. Omit it when it adds nothing; do not force one into every draft or default to never asking. Do not assume they use the repo, run a particular setup or share an operational problem. Avoid stock pain questions, and do not add a second question if the opener already asks one.
- Preserve the founder's signature directive. A greeting is optional only when compatible with the VOICE card.
- Do not imply they should abandon the starred repo, position it as an incumbent to displace, offer discounts or credits, ask for a call, or promise a sketch/snippet/teardown you do not have. Do not announce that you researched their profile. Avoid internal billing jargon.

## Voice

Use the configured founder's register. Without a card, be plain and conversational. Shared interest should feel possible, not asserted as a fact about the reader. Dryness, warmth, bluntness and humor belong to the founder's card; none is imposed by this play.

Output as a JSON object only: { "subject": string, "body": string }.

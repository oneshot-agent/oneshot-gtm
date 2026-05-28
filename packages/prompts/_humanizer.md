# Anti-AI-slop rules (apply to ALL output)

These rules are based on Wikipedia's "Signs of AI writing" canon. Violate them and the output reads like a chatbot. Treat each one as hard.

## Banned vocabulary (high-frequency AI tells)

NEVER use these in any output: additionally, align with, crucial, delve, emphasize, enduring, enhance, foster, garner, highlight, interplay, intricate, intricacies, key (as adjective), landscape (figurative), pivotal, showcase, tapestry, testament, underscore, valuable, vibrant, profound, robust, seamless, comprehensive, leverage (verb), unlock, navigate (figurative), elevate, empower, transform, journey (figurative), realm, ecosystem (figurative), at the intersection of, in the heart of, nestled.

## Banned constructions

- **Copula avoidance**: NEVER write "X serves as Y", "X stands as Y", "X represents Y", "X marks a Y", "X functions as Y". Just say "X is Y".
- **Superficial -ing tails**: NEVER tack on "...highlighting...", "...underscoring...", "...reflecting...", "...emphasizing...", "...showcasing...", "...fostering...", "...ensuring...". They're filler.
- **Negative parallelism**: NEVER use "It's not just X, it's Y" or "Not only X but also Y". Pick one and say it.
- **Rule of three**: NEVER force three-item lists when two would do. "Speed, quality, and adoption" is a tell.
- **False ranges**: NEVER write "from X to Y" when X and Y aren't on a scale.
- **Significance puffery**: NEVER claim something "marks a turning point", "represents a shift", "underscores its importance", "is a testament to", "reflects broader trends". Just describe what happened.
- **Vague attributions**: NEVER write "industry observers say", "experts believe", "many sources note". Either name the source or drop the claim.
- **Promotional adjectives**: NEVER write "groundbreaking", "renowned", "revolutionary", "must-have", "stunning", "breathtaking", "world-class", "cutting-edge".

## Banned punctuation and formatting

- **Em dashes (—)**: NEVER use em dashes. Use a period or a comma.
- **Curly quotes ("")**: NEVER use curly quotes. Use straight ASCII quotes (").
- **Boldface mid-sentence**: NEVER bold a phrase for emphasis. Make the sentence carry the weight.
- **Inline-header lists**: NEVER write `- **Speed**: faster code` style lists. Write a sentence.
- **Title Case Headings**: NEVER use Title Case in headings. Use sentence case.
- **Emojis**: NEVER use emojis as bullets, headers, or decoration.

## Banned chatbot artifacts

- NEVER open with "Great question!", "Certainly!", "Of course!", "I hope this helps", "I'd be happy to".
- NEVER close with "Let me know if you'd like me to...", "Hope this helps!", "Happy to expand on any section".
- NEVER include knowledge-cutoff hedges: "as of my last training", "based on available information", "while specific details are limited".

## Banned hedging and filler

- NEVER write "in order to". Write "to".
- NEVER write "due to the fact that". Write "because".
- NEVER write "at this point in time". Write "now".
- NEVER write "it could potentially possibly". Write "may" or just say it.
- NEVER write "it is important to note that". Just note it.
- NEVER write "the system has the ability to". Write "the system can".
- NEVER write "the future looks bright", "exciting times lie ahead", "a journey toward excellence", "this represents a major step".

## Banned email openers

NEVER start an email with any of these phrasings:

- "I noticed..."
- "I came across..."
- "Hope this email finds you well" / "Hope this finds you well"
- "Quick question..."
- "Loved your launch..."
- "Reaching out because..."

These openers signal cold outreach to anyone who has read a sales email. Start with the specific evidence or angle.

## Banned CTAs

NEVER use these calls-to-action:

- "I'd love to chat / connect / jump on a call / hear..."
- "Worth a 15-min..." / "Worth a 15 min..."
- "Mind if I..."

If you want a call, name what you'd cover or what you'd offer. The CTA should describe the actual exchange, not a vague intent.

## Banned filler

NEVER use:

- "Just wanted to..."
- "curious to learn..." / "curious to hear..."

These soften the ask and waste the reader's first sentence.

## Banned servile closers

NEVER close with:

- "Hope this helps"
- "Let me know if you'd like..."
- "Happy to expand..."

The reader knows how to respond. Sign off with the founder's name, no servility.

## Banned knowledge-cutoff hedges

NEVER hedge with:

- "as of my last training"
- "based on available information"
- "while specific details are limited"

These are chatbot artifacts pasted into output. Drop them.

## Email-specific formatting

- Max one exclamation per email. Two or more reads as bot energy.
- Subject case: lowercase the whole subject line. That includes brand names (`twilio`, not `TWILIO`) and acronyms (`api` not `API`). The post-generation lint flags any run of two-or-more uppercase letters, real acronyms included. Lowercase across the board avoids the flag.
- Body length: aim for ≤80 words. Most plays cap at 80-100 words; longer drafts get flagged. PMF surveys are the exception (they cap at 200).
- No Calendly URLs in body. The founder adds the scheduling link manually if relevant. Embedding it in a generated draft signals a bot.

## Voice rules

- Have an opinion. Don't just neutrally report.
- Vary sentence length. Mix short and long.
- Use "I" when it fits. First person reads as honest.
- Be specific over abstract. Numbers, names, dates beat adjectives.
- Acknowledge complexity when it exists. "Impressive but unsettling" beats "impressive".
- Let some structural mess in. Perfect symmetry feels algorithmic.

These rules are enforced post-generation by `lintEmail()`. Compliance up front means zero rewrite cost. Every flag the linter raises is a token you didn't need to spend on a regenerate.

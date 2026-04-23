# Reddit r/SaaS launch post

**Title:** [Show] Open-source CLI for founder-led GTM with pay-per-result pricing — built for pre-PMF teams

**Body:**

We're an early-stage team that kept running into the same problem: the standard GTM stack (Apollo, Clay, Outreach, Smartlead, etc.) assumes you have product-market fit and optimizes you for "send more." If you don't have PMF yet, that just amplifies the wrong message faster.

We open-sourced `oneshot-gtm`, a TypeScript CLI that runs named GTM plays — customer-discovery interviews, PMF surveys, Show HN founder-to-founder outreach, post-funding triggers, concierge onboarding voice calls — on top of OneShot, a pay-per-result API for email/SMS/voice/research/enrichment.

What's actually different from the existing tools:

1. **No subscription.** You pay per call. Stop using = stop paying. The signed receipts mean per-play CAC is deterministic, not blended.

2. **Discipline encoded.** Some commands have soft gates. `handoff templatize` prints a pre-flight checklist (have you logged 100 hand-written sends? what was the reply rate?) before extracting a template. The default answer is "not yet, fix this first." You can override with `y` if you disagree.

3. **MIT.** Every prompt is in the repo. Every play is a single file you can fork.

4. **BYO LLM.** OpenRouter recommended (one key, all models). OpenAI and Anthropic supported.

For r/SaaS specifically: this is built for the period between "I have a product that kinda works" and "I have a sales team." If you're at $0-$1M ARR doing founder-led sales, this is the shape of the tool.

Repo: github.com/oneshot-agent/oneshot-gtm

Quick start:

```bash
bunx oneshot-gtm init
bunx oneshot-gtm intel advise   # interactive coach, no OneShot calls
bunx oneshot-gtm motion show-hn --target ./examples/show-hn.json --dry-run
```

Genuinely would love criticism, especially:

- "Why would I use this instead of [tool]?"
- "Show me the play I actually want and you didn't ship."
- "Your soft-gates pattern is wrong because…"

— [your name]

---

**Posting strategy:**

- r/SaaS rules: must include genuine value, no pure self-promo. The post above leans on actual mechanics, not hype.
- Mid-week mornings Eastern.
- Avoid superlatives ("revolutionary", "game-changer") — they get downvoted hard on r/SaaS.
- Be ready to defend pricing claims with concrete examples ("here's an actual receipt for sending an email + enriching a profile").

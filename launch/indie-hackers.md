# Indie Hackers launch post

**Title:** Just shipped: pay-per-result GTM agent (no SaaS, MIT) — looking for IH feedback

**Body:**

After 8 months building OneShot (pay-per-use APIs for email, voice, research, enrichment with on-chain signed receipts), we kept hearing the same thing from indie founders: "the API is great but I don't want to wire up Clay + Smartlead + Apollo + Outreach + an LLM just to send 30 cold emails this week."

So we open-sourced the wrapper. `oneshot-gtm` is a TypeScript CLI that ships ~10 named GTM plays — Show HN founder-to-founder outreach, post-funding triggers, customer-discovery interviews, PMF surveys, concierge onboarding voice calls — and runs them on top of OneShot's pay-per-result infra.

For IH specifically:

- **No subscription.** Pay $0.05-$2 per outbound touch (depending on what enrichment / research you stack on). Stop sending = stop paying.
- **Receipts you can screenshot.** Every action emits a signed receipt with the cost. `measure cac` per play. Tweet-worthy unit economics.
- **Bring your own LLM.** OpenRouter recommended (one key, all models). OpenAI and Anthropic supported.
- **MIT.** Read every prompt. Fork every play. We expect you to.

What's specifically NOT for IH and I want to flag honestly:

- This is built for _outbound_ GTM. If you're a pure SEO / content / community-led shop, the value here is thinner.
- The voice onboarding play uses an autonomous AI voice call. Some prosumer audiences hate this. Use judgment.
- We make money when you spend on OneShot. The repo is genuinely open and forkable, but conflict-of-interest disclosure: we benefit when this gets adoption.

Things I'd love IH feedback on:

1. The "soft gates" — would you find it annoying if `motion templatize` printed a checklist before letting you bulk-send? Or useful?
2. Pricing legibility — does printing the receipt URL after every action solve the "agentic apps are scary because the bill is unknowable" problem for you?
3. Which play would actually move the needle for your current week? I'll prioritize that for Phase 1.

Repo: github.com/oneshot-agent/oneshot-gtm
Try it: `bunx oneshot-gtm init` (Bun + an LLM key + an OneShot wallet — 5 min total)

— [your name]

---

**Posting strategy:**

- IH respects vulnerability. The "what's NOT for you" section above is doing real work.
- Post in the "Launch" or "Show IH" section, mid-week, morning Pacific.
- Cross-post to ProductHunt only if the vhs recording is polished — IH and PH have very different vibes.

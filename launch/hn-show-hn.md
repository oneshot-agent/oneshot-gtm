# Show HN: oneshot-gtm — open-source GTM agent for technical founders

**Title:** Show HN: oneshot-gtm — open-source GTM agent (CLI + local dashboard) with pay-per-result + signed receipts

**Body:**

Hi HN,

We built oneshot-gtm, an open-source TypeScript monorepo (Bun + Turbo + TanStack + Base UI) that wraps named GTM plays (cold outbound, customer-discovery interviews, PMF surveys, voice onboarding, multichannel cadences) on top of OneShot — a pay-per-use API for email/SMS/voice/research/enrichment with cryptographically signed receipts settled on Base.

Two surfaces, one local SQLite ledger:

- **CLI** for power users + scripting (33 commands across 7 groups)
- **Local web dashboard** (`bunx oneshot-gtm ui` → opens `http://127.0.0.1:3030`) for visibility + non-technical co-founders. Read-only Home/Cadences/Receipts/Plays/Measure pages, plus three mutation flows (Setup wizard, Run-a-play with SSE-streamed drafts, Log-outcome modal).

The thing we wanted to fix: most GTM tools (Apollo, Clay, Outreach, Lemlist) assume you've already found PMF and just optimize sends. Pre-PMF founders end up scaling broken motions because the tool says "send more." So we encoded the canonical pre-PMF playbook (Mom Test, Sean Ellis 40%, Predictable Revenue, "do things that don't scale") as actual commands. `motion templatize` won't run until you've logged 100 hand-written sends with reply outcomes. `handoff first-ae` returns "not yet" if Sean Ellis is below 40%.

The receipts are the unique part: every paid action prints a signed, on-chain-verifiable cost. `measure cac` rolls them up per play. You can show an investor your real CAC instead of a guess.

Repo: github.com/oneshot-agent/oneshot-gtm
Docs: docs.oneshotagent.com
MIT license. Bring your own LLM key (OpenRouter, OpenAI, or Anthropic) and a OneShot wallet.

```
bunx oneshot-gtm init
```

What's open: every prompt, every play, every cost. What's not: the email/SMS/voice infra (OneShot handles auto-provisioned warm sending domains, x402 payment flow, and receipt cryptography).

Looking for feedback on:

1. The plays we picked for Phase 0 vs Phase 1 — are we missing the obvious one?
2. The "soft gates" pattern — useful or paternalistic?
3. Anyone want to dogfood with us? Free credits for HN folks for the first 30 days; just email [your email] with your project.

— [your name], [your company]

---

**Posting strategy:**

- Post Tuesday or Wednesday, 8-10am Pacific.
- One author replies in-thread within 15 min.
- Have 2-3 batchmates ready to upvote organically (do not ring-vote).
- First 5 comments matter more than anything else for ranking.
- Be ready to answer: "How does this differ from X?" (table is in the README), "What does it cost?" (link to OneShot pricing), "Why on-chain?" (the receipts are the moat, not the chain).

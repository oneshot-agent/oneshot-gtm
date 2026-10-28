import { describe, expect, it } from "vitest";
import { bodyCommitsTerms } from "../src/reply.ts";
import { founderSteerBlock, intentDirectiveBlock } from "../src/_lib.ts";

// commits-terms fixtures verbatim from the live sdk workspace (issue #480):
// the Aladdin draft that committed the founder to documentation placement, a
// "recommended partner" designation, and a reference-implementation feature
// (none of it authorised) and the harmless Rahul one-liner that must NOT
// trip the flag.

const ALADDIN_DRAFT = `Hey Aladdin,

I like the direction. Having OneShot sit invisibly as the execution engine for your research and commerce tools fits exactly how we want the SDK to be used, as a utility, not a brand users have to manage.

On the distribution side, i can point our hackathon builders and consultants toward AladdinAI as the recommended sovereign environment for their agents. When someone asks for a self-hosted workspace to run the OneShot tools they've just tested, your repo is the logical destination.

Realistically, we can start by adding AladdinAI to our documentation as a primary integration path and featuring your setup in our oneshot-gtm reference implementation. Does that give you the visibility you're looking for, or were you thinking of a more direct hand-off?

J. Nicolas
oneshotagent.com`;

const RAHUL_ONE_LINER = `Hey Rahul,

Fair call. I went way too heavy on the technical baggage there.

Since you're building a factory for these workflows, do you usually prefer wiring up the individual vendor apis yourself, or is that the part you'd rather offload?

J. Nicolas
oneshotagent.com`;

describe("bodyCommitsTerms (issue #480)", () => {
  it("fires on the Aug 30 Aladdin draft — distribution, docs placement, recommended-partner, reference implementation", () => {
    expect(bodyCommitsTerms(ALADDIN_DRAFT)).toBe(true);
  });

  it("does not fire on the harmless Rahul one-liner", () => {
    expect(bodyCommitsTerms(RAHUL_ONE_LINER)).toBe(false);
  });

  it("fires on pricing/discount language", () => {
    expect(bodyCommitsTerms("Sure, I can do a 20% discount for the first year.")).toBe(true);
  });

  it("fires on roadmap dates and headcount commitments", () => {
    expect(bodyCommitsTerms("We're planning to ship SSO by Q1 next year.")).toBe(true);
    expect(bodyCommitsTerms("We could hire someone dedicated to your account.")).toBe(true);
  });

  it("does not fire on ordinary product-substance answers", () => {
    expect(
      bodyCommitsTerms(
        "The StageRunRequest flow signs a receipt for every call, so the runtime is the source of truth.",
      ),
    ).toBe(false);
  });

  // Round-1 correction (#480): the send gate matched bare topic words, not
  // actual commitments, so ordinary declines/neutral mentions of the same
  // words tripped `commits-terms` and blocked Send on harmless replies.
  it("does not fire on a neutral, non-committing mention of pricing", () => {
    expect(bodyCommitsTerms("Our pricing is public, check the website.")).toBe(false);
  });

  it("does not fire when discounts are explicitly declined", () => {
    expect(bodyCommitsTerms("We don't offer discounts right now, sorry.")).toBe(false);
  });

  it("does not fire when exclusivity is explicitly declined", () => {
    expect(bodyCommitsTerms("We can't agree to exclusivity at this stage.")).toBe(false);
  });

  it("does not fire when a partnership is explicitly declined", () => {
    expect(bodyCommitsTerms("We're not looking for any partnership right now.")).toBe(false);
  });

  it("does not fire when hiring is explicitly declined", () => {
    expect(bodyCommitsTerms("No, we won't be hiring for this.")).toBe(false);
  });

  // Round-2 correction (#480): 6 of 8 patterns had no requireAffirmative
  // guard, so a harmless mention/question tripped commits-terms and blocked
  // Send. Verbatim reviewer-reproduced false positives, now gated the same
  // way pricing already was.
  it("does not fire on a harmless acknowledgement that merely mentions partnership", () => {
    expect(bodyCommitsTerms("Thanks for explaining the partnership, that makes sense.")).toBe(
      false,
    );
  });

  it("does not fire when the roadmap is only being asked about, not promised", () => {
    expect(bodyCommitsTerms("Could you clarify your roadmap?")).toBe(false);
  });

  it("does not fire on a neutral, non-committing mention of distribution", () => {
    expect(bodyCommitsTerms("We read about your distribution model on the website.")).toBe(false);
  });

  it("does not fire on small talk about hiring", () => {
    expect(bodyCommitsTerms("How is your hiring going this quarter?")).toBe(false);
  });

  // Round-3 correction (#480/#558): NEGATION_CUE matched anywhere in the
  // sentence, so a trailing hedge unrelated to the commitment cleared the
  // gate: reviewer-reproduced false negative from PR #556.
  it("still fires when an unrelated negation trails the commitment in the same sentence", () => {
    expect(bodyCommitsTerms("Sure, I can do a 20% discount, no problem.")).toBe(true);
  });

  it("does not fire when the negation applies to the same clause as the commitment", () => {
    expect(bodyCommitsTerms("We don't offer discounts right now, sorry.")).toBe(false);
  });

  // Round-4 correction (#558): the round-3 fix anchored the clause's start at
  // the nearest PRECEDING comma, so a negation separated from the matched
  // keyword by a parenthetical aside (its own comma-delimited fragment)
  // landed outside the checked span and this returned true. A real
  // regression on a legitimate, explicit refusal main correctly clears.
  it("does not fire when a negation is separated from the commitment by a parenthetical aside", () => {
    expect(bodyCommitsTerms("We will not, under any circumstances, offer a discount.")).toBe(false);
  });

  // Round-2 correction (#558, this round): the round-1 fix scoped
  // NEGATION_CUE to the leading clause (start of sentence through the next
  // comma after the matched keyword), which incidentally fixed the
  // parenthetical-aside case above but broke this one. A genuine refusal
  // that legitimately follows the comma landed outside the checked clause
  // and this returned true against main's correct false. Fixed by stripping
  // only the specific "no problem"/"no worries" hedge idiom and checking
  // NEGATION_CUE against the whole sentence again, like main.
  it("still catches a refusal that follows a comma in the same sentence", () => {
    expect(bodyCommitsTerms("We can review pricing, but cannot offer a discount.")).toBe(false);
  });

  // A designation or a feature counts only when the founder makes it: naming
  // the other party's preferred tool, or thanking them for featuring us, is not.
  it("fires when the founder designates the other party recommended or preferred", () => {
    expect(bodyCommitsTerms("We can make you our recommended provider for new customers.")).toBe(
      true,
    );
    expect(
      bodyCommitsTerms(
        "i can point our users toward Beacon as the recommended environment for their work.",
      ),
    ).toBe(true);
  });

  it("does not fire on a recommended or preferred label the founder does not give", () => {
    expect(bodyCommitsTerms("I can see why it's your preferred platform.")).toBe(false);
    expect(bodyCommitsTerms("I understand it's the preferred option for your team.")).toBe(false);
    expect(bodyCommitsTerms("We would love to be your preferred vendor.")).toBe(false);
  });

  it("fires when the founder offers to feature the other party", () => {
    expect(bodyCommitsTerms("We'll feature your setup in our newsletter next month.")).toBe(true);
    expect(bodyCommitsTerms("Happy to feature your integration in our docs.")).toBe(true);
  });

  it("does not fire when the other party featured the founder", () => {
    expect(bodyCommitsTerms("Thanks for featuring us in your newsletter.")).toBe(false);
    expect(bodyCommitsTerms("It's great that you'd feature us on your blog.")).toBe(false);
  });

  it("counts 'let me' / 'let us' as a commitment only for feature and endorsement offers", () => {
    expect(bodyCommitsTerms("Let me feature your integration in our docs.")).toBe(true);
    expect(bodyCommitsTerms("Let us make you our recommended provider.")).toBe(true);
    expect(bodyCommitsTerms("Let me explain our pricing.")).toBe(false);
    expect(bodyCommitsTerms("Let us walk you through the roadmap.")).toBe(false);
    expect(bodyCommitsTerms("Let me show you the feature in our docs.")).toBe(false);
    expect(bodyCommitsTerms("Let me point out that you are the recommended provider.")).toBe(false);
  });
});

describe("intentDirectiveBlock (issue #480)", () => {
  it("returns a structured directive for interested, distinct from the default pitch framing", () => {
    const block = intentDirectiveBlock("interested");
    expect(block).toContain("INTENT DIRECTIVE");
    expect(block).toContain("interested");
    expect(block).toMatch(/do not commit/i);
  });

  it("returns null for unclassified or non-directive intents", () => {
    expect(intentDirectiveBlock(null)).toBeNull();
    expect(intentDirectiveBlock(undefined)).toBeNull();
    expect(intentDirectiveBlock("auto_reply")).toBeNull();
    expect(intentDirectiveBlock("other")).toBeNull();
  });

  it("has a distinct block per handled category", () => {
    const categories = ["interested", "not_now", "wrong_person", "objection", "question"];
    const blocks = categories.map((c) => intentDirectiveBlock(c));
    expect(blocks.every((b) => b !== null)).toBe(true);
    expect(new Set(blocks).size).toBe(categories.length);
  });
});

describe("founderSteerBlock (issue #480)", () => {
  it("wraps a non-empty steer as a binding instruction", () => {
    const block = founderSteerBlock("docs listing only, no exclusivity, no traffic promise");
    expect(block).toContain("FOUNDER STEER");
    expect(block).toContain("docs listing only, no exclusivity, no traffic promise");
  });

  it("returns null for empty/whitespace/absent steer", () => {
    expect(founderSteerBlock(null)).toBeNull();
    expect(founderSteerBlock(undefined)).toBeNull();
    expect(founderSteerBlock("   ")).toBeNull();
  });
});

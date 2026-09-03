import { describe, expect, it } from "vitest";
import { bodyCommitsTerms } from "../src/reply.ts";
import { founderSteerBlock, intentDirectiveBlock } from "../src/_lib.ts";

// commits-terms fixtures verbatim from the live sdk workspace (issue #480):
// the Aladdin draft that committed the founder to documentation placement, a
// "recommended partner" designation, and a reference-implementation feature
// — none of it authorised — and the harmless Rahul one-liner that must NOT
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

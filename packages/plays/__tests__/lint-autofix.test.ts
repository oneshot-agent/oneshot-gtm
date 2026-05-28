import { describe, expect, it } from "vitest";
import { humanizeDraft, lintEmail } from "../src/_lib.ts";

describe("humanizeDraft — deterministic auto-fix", () => {
  it("replaces em-dashes with `, ` and collapses surrounding spaces", () => {
    const out = humanizeDraft({ subject: "a — b", body: "x — y — z" });
    expect(out.subject).toBe("a, b");
    expect(out.body).toBe("x, y, z");
  });

  it("handles em-dashes without surrounding spaces", () => {
    const out = humanizeDraft({ subject: "x", body: "tight—dash here" });
    expect(out.body).toBe("tight, dash here");
  });

  it("preserves newlines around an em-dash (does not silently merge paragraphs)", () => {
    const out = humanizeDraft({
      subject: "x",
      body: "first paragraph —\nsecond paragraph",
    });
    // The em-dash + adjacent horizontal space collapse to `, ` but the
    // `\n` survives, so the paragraph break stays visible.
    expect(out.body).toBe("first paragraph,\nsecond paragraph");
  });

  it("strips flag emoji (regional indicator pairs)", () => {
    const out = humanizeDraft({ subject: "🇺🇸 release", body: "shipping in 🇨🇦 too" });
    expect(out.subject).toBe("release");
    expect(out.body).toBe("shipping in  too");
  });

  it("replaces curly quotes with straight ASCII quotes", () => {
    const out = humanizeDraft({
      subject: "the “stack” question",
      body: "she said ‘hi’ and “left”",
    });
    expect(out.subject).toBe('the "stack" question');
    expect(out.body).toBe(`she said 'hi' and "left"`);
  });

  it("strips emoji and their variation selectors from both subject and body", () => {
    const out = humanizeDraft({ subject: "ship 🚀 fast", body: "thanks 👍 again ☀️" });
    expect(out.subject).toBe("ship  fast");
    // Trailing space stripped by .trim(); inner double-space preserved.
    expect(out.body).toBe("thanks  again");
  });

  it("collapses runs of `!` to a single `!`", () => {
    const out = humanizeDraft({ subject: "hello!!!", body: "wow!! great! amazing!! end" });
    expect(out.subject).toBe("hello!");
    expect(out.body).toBe("wow! great! amazing! end");
  });

  it("collapses `! !` (separated by whitespace) to a single `!`", () => {
    const out = humanizeDraft({ subject: "x", body: "go ! ! now" });
    expect(out.body).toBe("go ! now");
  });

  it("is idempotent on already-clean input", () => {
    const clean = { subject: "lower-case subject", body: "no slop here, just text." };
    expect(humanizeDraft(clean)).toEqual(clean);
    expect(humanizeDraft(humanizeDraft(clean))).toEqual(clean);
  });

  it("strips leading and trailing whitespace", () => {
    const out = humanizeDraft({ subject: "  spaced  ", body: "\nbody\n" });
    expect(out.subject).toBe("spaced");
    expect(out.body).toBe("body");
  });
});

describe("humanizeDraft + lintEmail — pipeline coverage", () => {
  it("removes em-dash, curly-quotes, emoji, excess-exclamations flags after auto-fix", () => {
    // `wow!!!` collapses to `wow!` (single run), leaving 1 `!` in the body.
    // Multi-clause cases like `fine! great!` would NOT auto-fix to silence
    // `excess-exclamations` — that's a semantic decision the LLM should
    // make, not a deterministic rewrite.
    const messy = {
      subject: "the question",
      body: "“hello” — world 🚀 fine!!! ok",
    };
    const beforeFlags = lintEmail(messy.subject, messy.body);
    expect(beforeFlags).toEqual(
      expect.arrayContaining(["em-dash", "curly-quotes", "emoji", "excess-exclamations"]),
    );
    const cleaned = humanizeDraft(messy);
    const afterFlags = lintEmail(cleaned.subject, cleaned.body);
    expect(afterFlags).not.toContain("em-dash");
    expect(afterFlags).not.toContain("curly-quotes");
    expect(afterFlags).not.toContain("emoji");
    expect(afterFlags).not.toContain("excess-exclamations");
  });

  it("does not silence semantic flags (rule-of-three should still fire)", () => {
    const cleaned = humanizeDraft({
      subject: "the question",
      body: "uses twilio, sendgrid, and langchain.",
    });
    const flags = lintEmail(cleaned.subject, cleaned.body);
    expect(flags).toContain("rule-of-three");
  });
});

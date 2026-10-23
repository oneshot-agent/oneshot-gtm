import { describe, expect, it } from "vitest";
import { flagAdvice, heldSummary, humanizeFlag } from "../src/lib/flagLabels.ts";

// Issue #594: the letter card says why it is held in words, not lint labels.

describe("humanizeFlag", () => {
  it("names the labels the linter emits today", () => {
    expect(humanizeFlag("rule-of-three")).toBe("rule of three");
    expect(humanizeFlag("banned-opener:I-noticed")).toBe("banned opener, “I noticed”");
    expect(humanizeFlag("banned-opener:hope-this-finds")).toBe("banned opener, “hope this finds”");
    expect(humanizeFlag("banned-opener:provenance-verb")).toBe("banned opener, “I was looking at”");
    expect(humanizeFlag("hard-ban:discount-offer")).toBe("hard ban: discount offer");
    expect(humanizeFlag("stale-event")).toBe("the event has passed");
    expect(humanizeFlag("contacted-elsewhere")).toBe("another workspace emailed them this week");
    expect(humanizeFlag("ungrounded")).toBe(
      "research found nothing on them; the draft leans on the company name",
    );
    expect(humanizeFlag("email-at-former-employer")).toBe(
      "their address is at a company they have left",
    );
  });

  it("degrades an unknown label to its words instead of hiding it", () => {
    expect(humanizeFlag("some-new-rule")).toBe("some new rule");
    expect(humanizeFlag("some-new-rule:with-detail")).toBe("some new rule: with detail");
  });
});

describe("heldSummary", () => {
  it("is null for a clean draft", () => {
    expect(heldSummary([])).toBeNull();
  });

  it("counts, names, and says what to do — lint blocks, review does not", () => {
    expect(heldSummary(["banned-opener:I-noticed", "rule-of-three"])).toEqual({
      kind: "lint",
      text: "2 flags: banned opener, “I noticed”, rule of three",
      next: "regenerate the draft",
    });
    expect(heldSummary(["stale-event"], { review: "send" })).toEqual({
      kind: "review",
      text: "1 flag: the event has passed",
      next: "read it once more, then send anyway",
    });
  });

  it("points an offer flag at the offer block, never at send or regenerate", () => {
    expect(heldSummary(["weak-offer"])).toEqual({
      kind: "review",
      text: "1 flag: the offer was rated a weak fit",
      next: "approve the offer, pick another or rewrite it",
    });
    expect(heldSummary(["no-offer"])?.next).toBe("write the offer or ask for new ones");
    for (const review of ["send", "approve", "regenerate"] as const) {
      for (const flag of ["weak-offer", "no-offer"]) {
        const next = heldSummary([flag], { review })!.next;
        expect(next).not.toContain("send");
        expect(next).not.toContain("regenerate");
      }
    }
  });

  it("names a writer's skip, and still points at the offer block", () => {
    expect(heldSummary(["no-offer"], { offerSkipped: true })).toEqual({
      kind: "lint",
      text: "1 flag: the writer found no offer to make",
      next: "write the offer or ask for new ones",
    });
    expect(heldSummary(["em-dash"], { offerSkipped: true })?.next).toBe("regenerate the draft");
  });

  it("treats a weak offer approved or replaced since like any other read-only flag", () => {
    expect(flagAdvice("weak-offer", { offerHeld: false, review: "send" })).toBe(
      "read it once more, then send anyway",
    );
    expect(flagAdvice("weak-offer", { offerHeld: false })).toBe("regenerate the draft");
  });

  it("says send only where Send can go: approve a pending row, regenerate where flags block", () => {
    expect(flagAdvice("stale-event", { review: "approve" })).toBe("approve to send");
    expect(flagAdvice("stale-event", { review: "regenerate" })).toBe("regenerate the draft");
    expect(flagAdvice("stale-event")).toBe("regenerate the draft");
  });

  it("says each distinct fix once, the offer's first", () => {
    expect(heldSummary(["em-dash", "rule-of-three", "weak-offer"])?.next).toBe(
      "approve the offer, pick another or rewrite it; regenerate the draft",
    );
  });

  it("a soft flag beside a lint flag is still a lint hold", () => {
    expect(heldSummary(["stale-event", "em-dash"])?.kind).toBe("lint");
    // ungrounded alone is a review hold with a send-anyway, not a lint block.
    expect(heldSummary(["ungrounded"], { review: "send" })).toEqual({
      kind: "review",
      text: "1 flag: research found nothing on them; the draft leans on the company name",
      next: "read it once more, then send anyway",
    });
  });
});

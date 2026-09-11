import { describe, expect, it } from "vitest";
import { heldSummary, humanizeFlag } from "../src/lib/flagLabels.ts";

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
      next: "regenerate to clear it, then send",
    });
    expect(heldSummary(["stale-event"])).toEqual({
      kind: "review",
      text: "1 flag: the event has passed",
      next: "read it once more, then send as-is",
    });
  });

  it("a soft flag beside a lint flag is still a lint hold", () => {
    expect(heldSummary(["stale-event", "em-dash"])?.kind).toBe("lint");
    // ungrounded alone is a review hold with a send-anyway, not a lint block.
    expect(heldSummary(["ungrounded"])).toEqual({
      kind: "review",
      text: "1 flag: research found nothing on them; the draft leans on the company name",
      next: "read it once more, then send as-is",
    });
  });
});

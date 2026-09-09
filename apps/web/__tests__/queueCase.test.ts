import { describe, expect, it } from "vitest";
import { caseMeta, caseRows } from "../src/lib/queueCase.ts";

// Issue #594: the case column lays the priority engine's reasons out as
// key–value rows where they have a key and as plain lines where they don't.

describe("caseRows", () => {
  it("splits a keyed reason and keeps a plain one whole", () => {
    expect(
      caseRows([
        "title: Co-Founder & CEO at Upgraded",
        "Guest at The Korea Playbook for Austin Physical AI Founders",
        "upcoming event",
        "1 evidence link",
      ]),
    ).toEqual([
      { key: "title", value: "Co-Founder & CEO at Upgraded" },
      { key: null, value: "Guest at The Korea Playbook for Austin Physical AI Founders" },
      { key: null, value: "upcoming event" },
      { key: null, value: "1 evidence link" },
    ]);
  });

  it("does not mistake a sentence with a colon for a key", () => {
    expect(caseRows(["bio: ai, founder, saas"])).toEqual([
      { key: "bio", value: "ai, founder, saas" },
    ]);
    expect(caseRows(["Public launch on Product Hunt today: 300 upvotes"])).toEqual([
      { key: null, value: "Public launch on Product Hunt today: 300 upvotes" },
    ]);
    expect(caseRows(["https://x.com/foo: seen"])).toEqual([
      { key: null, value: "https://x.com/foo: seen" },
    ]);
  });

  it("drops blanks and repeats", () => {
    expect(caseRows(["", "  ", "2.1k followers", "2.1k followers "])).toEqual([
      { key: null, value: "2.1k followers" },
    ]);
  });
});

describe("caseMeta", () => {
  it("joins what exists with middle dots and is null when nothing does", () => {
    expect(caseMeta(["YC S26", null, "yc-s26", undefined, " found 6 days ago "])).toBe(
      "YC S26 · yc-s26 · found 6 days ago",
    );
    expect(caseMeta([null, "", undefined])).toBeNull();
  });
});

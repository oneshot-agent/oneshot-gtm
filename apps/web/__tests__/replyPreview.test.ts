import { describe, expect, it } from "vitest";
import { replyCompany, replyPreview } from "../src/lib/replyPreview.ts";

describe("reply list presentation", () => {
  it("omits imported placeholders but preserves real company names", () => {
    for (const value of [null, "", " (unknown) ", "Unknown", "N/A", "-"])
      expect(replyCompany(value)).toBeNull();
    expect(replyCompany("Unknown Labs")).toBe("Unknown Labs");
  });
  it("removes quoted email history from previews, including inline attributions", () => {
    expect(
      replyPreview("Who are you? On Sat, Sep 19, 2026, 2:53 AM Pat wrote:\nOld pitch", "email"),
    ).toBe("Who are you?");
    expect(replyPreview("Thanks!\n> Old pitch", "email")).toBe("Thanks!");
    expect(replyPreview("Thanks!\n-----Original Message-----\nFrom: Pat", "email")).toBe("Thanks!");
  });
  it("preserves normal prose and LinkedIn content", () => {
    expect(replyPreview("On September 19 we can talk.\nDoes that work?", "email")).toBe(
      "On September 19 we can talk. Does that work?",
    );
    expect(replyPreview("Here's the example:\n> code", "linkedin")).toBe(
      "Here's the example: > code",
    );
  });
});

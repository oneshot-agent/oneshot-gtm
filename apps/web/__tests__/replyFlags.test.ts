import { describe, expect, it } from "vitest";
import {
  describeReplyFlag,
  describeReplyMove,
  replyDraftNote,
  replySetNote,
} from "../src/lib/replyFlags.ts";

// The composer says what a reply flag means in words, not the linter's label.

describe("replyDraftNote", () => {
  it("is null for a clean option", () => {
    expect(replyDraftNote([])).toBeNull();
  });

  it("turns one flag into a sentence about the text", () => {
    expect(replyDraftNote(["link-not-in-brief"])).toBe(
      "Check before sending: it links to a page that is not in your product brief.",
    );
  });

  it("joins several flags into one sentence", () => {
    expect(replyDraftNote(["commits-terms", "too-many-links", "repeats-you"])).toBe(
      "Check before sending: it commits to pricing or terms, has more than one link, and it repeats something you already sent them.",
    );
  });

  it("degrades an unknown flag to its words instead of hiding it", () => {
    expect(describeReplyFlag("some-new-rule")).toBe("some new rule");
    expect(describeReplyFlag("banned-opener:I-noticed")).toBe("banned opener, “I noticed”");
  });
});

describe("replySetNote", () => {
  it("is null for three distinct options", () => {
    expect(replySetNote([])).toBeNull();
  });

  it("names the options that overlap and says what to do", () => {
    expect(replySetNote(["near-duplicate:technical+warm"])).toBe(
      "The options overlap: Technical and Warm say nearly the same thing. Regenerate for three distinct options.",
    );
    expect(replySetNote(["same-move", "near-duplicate:direct+warm"])).toBe(
      "The options overlap: the three options take the same approach, and Direct and Warm say nearly the same thing. Regenerate for three distinct options.",
    );
  });
});

describe("describeReplyMove", () => {
  it("names the stance in words and passes an unknown move through", () => {
    expect(describeReplyMove("reframe")).toBe("Says what it is and is not for them");
    expect(describeReplyMove("ask")).toBe("Asks one question back");
    expect(describeReplyMove("new-move")).toBe("new-move");
    expect(describeReplyMove(undefined)).toBeNull();
  });
});

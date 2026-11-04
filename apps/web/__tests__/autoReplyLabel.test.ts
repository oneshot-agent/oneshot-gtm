import { describe, expect, it } from "vitest";
import { autoReplyLabel } from "../src/lib/autoReplyLabel.ts";

describe("autoReplyLabel", () => {
  it("names what a read auto-reply said", () => {
    expect(autoReplyLabel({ kind: "auto_permanent", autoReason: "left_company" })).toBe(
      "left company",
    );
    // The model can find a departure the rules called a plain auto-reply.
    expect(autoReplyLabel({ kind: "auto", autoReason: "left_company" })).toBe("left company");
    expect(
      autoReplyLabel({ kind: "auto", autoReason: "out_of_office", returnDate: "2026-11-09" }),
    ).toBe("away until Nov 9");
    expect(autoReplyLabel({ kind: "auto", autoReason: "out_of_office", returnDate: null })).toBe(
      "away · no return date",
    );
  });

  it("falls back to the deliverability kind", () => {
    expect(autoReplyLabel({ kind: "auto" })).toBe("automatic reply");
    expect(autoReplyLabel({ kind: "auto", autoReason: "other" })).toBe("automatic reply");
    expect(autoReplyLabel({ kind: "auto_permanent" })).toBe("mailbox unavailable");
    expect(autoReplyLabel({ kind: "unsubscribe" })).toBe("opted out");
  });
});

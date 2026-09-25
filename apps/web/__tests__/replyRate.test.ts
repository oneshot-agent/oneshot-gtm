import { describe, expect, it } from "vitest";
import { MIN_SENDS_FOR_RATE, replyLabel } from "../src/lib/replyRate.ts";

describe("replyLabel", () => {
  it("withholds a rate below the minimum sample", () => {
    expect(replyLabel(1, 12)).toBe(
      `1 replied · rate after ${MIN_SENDS_FOR_RATE} sends (12 so far)`,
    );
  });
  it("shows a rate once the sample is big enough", () => {
    expect(replyLabel(3, 73)).toBe("3 replied (4.1%)");
    expect(replyLabel(12, 60)).toBe("12 replied (20%)");
  });
  it("handles no sends", () => {
    expect(replyLabel(0, 0)).toBe("0 replied");
  });
});

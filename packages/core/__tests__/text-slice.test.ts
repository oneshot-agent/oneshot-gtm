import { describe, expect, it } from "vitest";
import { sliceText } from "../src/text-slice.ts";

describe("sliceText", () => {
  it("drops a high surrogate the cut would leave behind", () => {
    // "𝙞" is two UTF-16 units; a cut at 5 lands between them.
    const out = sliceText("Amaz𝙞ng", 5);
    expect(out).toBe("Amaz");
    expect(out.isWellFormed()).toBe(true);
  });

  it("keeps a whole pair and plain text as slice would", () => {
    expect(sliceText("Amaz𝙞ng", 6)).toBe("Amaz𝙞");
    expect(sliceText("hello", 3)).toBe("hel");
    expect(sliceText("hi", 10)).toBe("hi");
    expect(sliceText("🤖", 0)).toBe("");
  });

  it("keeps the payload JSON well formed", () => {
    const bio = `${"x".repeat(599)}𝙞`;
    expect(JSON.stringify({ bio: sliceText(bio, 600) })).not.toMatch(/\\ud8/);
  });
});

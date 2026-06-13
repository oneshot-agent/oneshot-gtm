import { describe, expect, it } from "vitest";
import { stripQuotedChain } from "../src/reply.ts";

describe("stripQuotedChain", () => {
  it("drops a Gmail-style quoted chain below the new reply", () => {
    const body = [
      "Hey, fair point on the opener.",
      "",
      "On Sat, Jun 13, 2026 at 2:44 AM JN Nicolas <jn@freebutter.ai> wrote:",
      "",
      "> Hey Vicente,",
      "> TrustClaw's approach to remote tool execution is solid.",
    ].join("\n");
    expect(stripQuotedChain(body)).toBe("Hey, fair point on the opener.");
  });

  it("cuts at the first quoted line when there is no attribution header", () => {
    const body = ["short answer: not yet.", "> your earlier email", "> more quoted text"].join("\n");
    expect(stripQuotedChain(body)).toBe("short answer: not yet.");
  });

  it("returns the full body when there is no quoted chain", () => {
    const body = "Thanks, this is genuinely useful. Let's talk next week.";
    expect(stripQuotedChain(body)).toBe(body);
  });

  it("keeps a leading '>' line (no real text above it yet) instead of returning empty", () => {
    // A body that opens with a quote (i > 0 guard) shouldn't collapse to "".
    const body = "> only quoted content";
    expect(stripQuotedChain(body)).toBe("> only quoted content");
  });
});

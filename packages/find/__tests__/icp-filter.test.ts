import { describe, expect, it, vi } from "vitest";

// icpFilter wraps an LLM call (`complete`). A classifier failure must NOT throw
// (which would abort the whole finder run) — it should drop the candidate.

let completeShouldThrow = false;

vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: () => "icp-filter system prompt",
  tryParseJsonObject: (raw: string, fb: unknown) => {
    try {
      return JSON.parse(raw);
    } catch {
      return fb;
    }
  },
  complete: async () => {
    if (completeShouldThrow) {
      throw new Error("Job 035ebe1e-9080-431d-b8be-cba5fd7f0bc6 timed out after 121");
    }
    return { content: JSON.stringify({ match: true, reason: "fits" }) };
  },
}));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: () => {} };
});

const { icpFilter } = await import("../src/_filter.ts");

describe("icpFilter — failure isolation", () => {
  it("drops the candidate (no throw) when the classifier errors", async () => {
    completeShouldThrow = true;
    const res = await icpFilter({ icp: "B2B SaaS for eng teams", candidate: { title: "Acme" } });
    expect(res.match).toBe(false);
    expect(res.reason).toMatch(/unavailable/i);
  });

  it("passes through without an LLM call when no ICP is set", async () => {
    completeShouldThrow = true; // proves complete() is never reached
    const res = await icpFilter({ icp: null, candidate: { title: "Acme" } });
    expect(res.match).toBe(true);
  });

  it("returns the classifier decision on the happy path", async () => {
    completeShouldThrow = false;
    const res = await icpFilter({ icp: "B2B SaaS", candidate: { title: "Acme" } });
    expect(res.match).toBe(true);
  });
});

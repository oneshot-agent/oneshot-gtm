import { describe, expect, it, vi } from "vitest";

// A malformed / truncated LLM response (non-throwing) must resolve to
// `match: null` — the transient-failure signal — NOT `match: false`, so
// callers drop the candidate WITHOUT persisting a rejected row that would
// burn its dedupeKey forever.

vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: () => "icp-filter system prompt",
  // Real parse so the malformed string actually fails and falls back to {}.
  tryParseJsonObject: (raw: string, fb: unknown) => {
    try {
      return JSON.parse(raw);
    } catch {
      return fb;
    }
  },
  // Resolves (no throw) with a truncated, unparseable body.
  complete: async () => ({ content: '{"match": tr' }),
}));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: () => {} };
});

const { icpFilter } = await import("../src/_filter.ts");

describe("icpFilter — malformed (non-throwing) classifier output", () => {
  it("resolves to match:null so the caller drops without persisting", async () => {
    const res = await icpFilter({ icp: "B2B SaaS", candidate: { title: "Acme" } });
    expect(res.match).toBeNull();
    expect(res.reason).toMatch(/malformed/i);
  });
});

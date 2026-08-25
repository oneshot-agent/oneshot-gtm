import { describe, expect, it, vi } from "vitest";

// qualifyPerson is the person-level ICP gate. Unlike icpFilter it is
// four-state: the extra `unclear` verdict is what triggers a paid profile
// lookup instead of a guess. These tests cover the code-owned transitions
// (pass-through, missing role text, malformed, thrown); the pass/reject
// judgement itself belongs to the prompt and is exercised by the offline
// replay in `qualify-person-replay.test.ts`.

let completeShouldThrow = false;
let responseBody = JSON.stringify({ verdict: "pass", reason: "fits" });

vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: () => "icp-filter-person system prompt",
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
    return { content: responseBody };
  },
}));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: () => {} };
});

const { qualifyPerson, hasRoleText } = await import("../src/_filter.ts");

const ICP = "Technical founders and engineering leads shipping AI agents in production";

describe("qualifyPerson — verdict plumbing", () => {
  it("passes through without an LLM call when no ICP is set", async () => {
    completeShouldThrow = true; // proves complete() is never reached
    const res = await qualifyPerson({ icp: null, person: { roleText: "Account Executive" } });
    expect(res.verdict).toBe("pass");
    completeShouldThrow = false;
  });

  it("returns `unclear` (not reject) when there is no role text, without calling the LLM", async () => {
    // Missing data must take the SAME escalation path as ambiguous data.
    // Rejecting here would silently drop everyone whose bio happened to be
    // blank — 31% of Luma candidates.
    completeShouldThrow = true; // proves complete() is never reached
    const res = await qualifyPerson({ icp: ICP, person: { name: "Nick", roleText: "" } });
    expect(res.verdict).toBe("unclear");
    expect(res.reason).toMatch(/no role text/i);
    completeShouldThrow = false;
  });

  it("returns `transient` when the classifier throws", async () => {
    // transient !== reject: the caller must drop WITHOUT persisting, or the
    // dedupeKey burns and the candidate is locked out of every future tick.
    completeShouldThrow = true;
    const res = await qualifyPerson({ icp: ICP, person: { roleText: "Manager" } });
    expect(res.verdict).toBe("transient");
    expect(res.reason).toMatch(/unavailable/i);
    completeShouldThrow = false;
  });

  it("returns `transient` on a malformed (non-throwing) response", async () => {
    responseBody = '{"verdict": "pa';
    const res = await qualifyPerson({ icp: ICP, person: { roleText: "Manager" } });
    expect(res.verdict).toBe("transient");
    expect(res.reason).toMatch(/malformed/i);
  });

  it("returns `transient` when the verdict is not one of the three allowed strings", async () => {
    // Guards against the model inventing "maybe" / "yes" / true.
    responseBody = JSON.stringify({ verdict: "maybe", reason: "hedging" });
    const res = await qualifyPerson({ icp: ICP, person: { roleText: "Manager" } });
    expect(res.verdict).toBe("transient");
  });

  it("carries each of the three real verdicts through unchanged", async () => {
    for (const verdict of ["pass", "reject", "unclear"] as const) {
      responseBody = JSON.stringify({ verdict, reason: "because" });
      const res = await qualifyPerson({ icp: ICP, person: { roleText: "Head of Growth" } });
      expect(res.verdict).toBe(verdict);
      expect(res.reason).toBe("because");
    }
    responseBody = JSON.stringify({ verdict: "pass", reason: "fits" });
  });
});

describe("hasRoleText — escalation predicate", () => {
  it("treats absent, empty and whitespace-only role text as missing", () => {
    expect(hasRoleText({})).toBe(false);
    expect(hasRoleText({ roleText: null })).toBe(false);
    expect(hasRoleText({ roleText: "" })).toBe(false);
    expect(hasRoleText({ roleText: "   " })).toBe(false);
  });

  it("treats any real text as present, however vague", () => {
    // "Manager" is present-but-ambiguous: it reaches the classifier and comes
    // back `unclear`. That is a different path from missing.
    expect(hasRoleText({ roleText: "Manager" })).toBe(true);
    expect(hasRoleText({ roleText: "Host" })).toBe(true);
  });
});

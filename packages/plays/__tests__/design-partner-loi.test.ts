import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies design-partner-loi drafts the first rung of the ask ladder (a
// scoped conversation ask, not a pilot or LOI ask), enrolls the 3-step ladder
// cadence on a real send, and — the acceptance criterion in issue #463 —
// REFUSES to draft for an owner-operator buyer rather than relying on the
// finders routing correctly by convention.

const calls = { llmInputBlocks: [] as string[], enrolled: 0 };
// Overridable per test — draft-length-retry.test.ts uses the same shape.
// Defaults to the harmless {subject:"s", body:"b"} every existing test relies on.
let nextDraft = { subject: "s", body: "b" };

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      founderName: "Founder",
      productOneLiner: "thing",
      productDomain: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: "test",
    }),
    enrichProfile: async () => ({ result: { profile: {} }, receiptId: 1 }),
    sendEmail: async () => ({ receiptId: 3 }),
    getLedger: () => ({
      getCadence: () => null,
      upsertProspect: () => 1,
      recordSequenceEvent: () => 1,
      hasSentSequenceEvent: () => false,
      findProspectByEmail: () => ({ id: 1 }),
      // sendDraftedEmail reads the stored ICP verdict before a first touch.
      getProspectById: () => null,
      listSequenceEventsForProspectPlay: () => [],
      prospectHasFirstTouch: () => false,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      enrollCadence: () => {
        calls.enrolled++;
      },
    }),
    receiptUrlForId: (id: number) => `oneshot://receipt/${id}`,
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      calls.llmInputBlocks.push(input.messages.find((m) => m.role === "user")?.content ?? "");
      return { content: JSON.stringify(nextDraft), provider: "t", model: "t" };
    },
  };
});

const { runDesignPartnerLoi, assertNotOwnerOperatorBuyer, isAllowedDesignPartnerLoiBuyerType } =
  await import("../src/design-partner-loi.ts");

const base = {
  name: "Jamie Buyer",
  email: "jamie@enterprise-corp.com",
  company: "Enterprise Corp",
  buyerType: "enterprise",
  yourEdge: "our evaluation harness matches their exact compliance checklist",
} as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
  nextDraft = { subject: "s", body: "b" };
});
afterEach(() => vi.clearAllMocks());

describe("assertNotOwnerOperatorBuyer — the routing guard", () => {
  it("throws for owner-operator (and case/whitespace variants)", () => {
    expect(() => assertNotOwnerOperatorBuyer("owner-operator")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("Owner-Operator")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("  owner operator  ")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("main-street")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("main street")).toThrow();
  });

  it("does not throw for enterprise / government / hardware", () => {
    expect(() => assertNotOwnerOperatorBuyer("enterprise")).not.toThrow();
    expect(() => assertNotOwnerOperatorBuyer("government")).not.toThrow();
    expect(() => assertNotOwnerOperatorBuyer("hardware")).not.toThrow();
  });

  // The guard is an ALLOWLIST of the three supported buyer types, not an
  // enumeration of known-bad labels — so an owner-operator-ish label the
  // guard has never seen before (a future finder/pack's own wording, or a
  // typo of a known-bad string) is refused too, not let through.
  it("throws for an unrecognized owner-operator-ish label, not just the known ones", () => {
    expect(() => assertNotOwnerOperatorBuyer("restaurant")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("small-business")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("sole-proprietor")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("main street business")).toThrow();
    expect(() => assertNotOwnerOperatorBuyer("owner-operater")).toThrow(); // typo of a known-bad string
  });
});

describe("isAllowedDesignPartnerLoiBuyerType — predicate mirror of the assert guard", () => {
  // A trigger's readiness gate (or the config route's warn-tier check) needs
  // to validate a `buyerType` WITHOUT throwing, before the trigger is ever
  // allowed to route to this play at all (issue #705). This predicate and
  // `assertNotOwnerOperatorBuyer` must never disagree.
  it("agrees with assertNotOwnerOperatorBuyer for every case, including whitespace/case variants", () => {
    for (const ok of ["enterprise", "government", "hardware", " Enterprise ", "HARDWARE"]) {
      expect(isAllowedDesignPartnerLoiBuyerType(ok)).toBe(true);
      expect(() => assertNotOwnerOperatorBuyer(ok)).not.toThrow();
    }
    for (const bad of ["owner-operator", "main-street", "restaurant", ""]) {
      expect(isAllowedDesignPartnerLoiBuyerType(bad)).toBe(false);
      expect(() => assertNotOwnerOperatorBuyer(bad)).toThrow();
    }
  });
});

describe("runDesignPartnerLoi", () => {
  it("drafts a design-partner conversation ask, naming the buyer type", async () => {
    await runDesignPartnerLoi({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).toContain("BUYER TYPE: enterprise");
    expect(calls.llmInputBlocks[0]).toContain("PROSPECT: Jamie Buyer at Enterprise Corp");
  });

  it("enrolls the ask-ladder cadence on a real send", async () => {
    const out = await runDesignPartnerLoi({ dryRun: false, targets: [{ ...base }] });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(1);
  });

  // The acceptance criterion: design-partner-loi must never be routed at an
  // owner-operator, asserted here rather than trusted to finder config — a
  // future pack could point the wrong lane at it. This is BEFORE any paid
  // call (no LLM draft is produced), and lands as an errorDraft, not a sent
  // email, so the target never reaches a real send.
  it("refuses to draft for an owner-operator buyerType, before any paid call", async () => {
    const out = await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, buyerType: "owner-operator" }],
    });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(false);
    expect(out.drafted[0]?.flags.some((f) => f.startsWith("error:"))).toBe(true);
    // No LLM call was made for this target — the guard fires in `prepare`.
    expect(calls.llmInputBlocks).toHaveLength(0);
  });

  it("refuses a main-street buyerType the same way", async () => {
    const out = await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, buyerType: "main-street" }],
    });
    expect(out.drafted[0]?.sent).toBe(false);
    expect(out.drafted[0]?.flags.some((f) => f.startsWith("error:"))).toBe(true);
  });
});

// Issue #707: an `enterprise` buyerType draft is held for a shape the general
// institutional rules allow — 4+ body sentences, or a personalised
// dossier-observation opener — while the identical draft under `government`
// sails through untouched. The stricter rule set is scoped to `enterprise`
// only, keyed on the target's own `buyerType` string.
describe("runDesignPartnerLoi — enterprise first-touch flags (issue #707)", () => {
  it("flags an enterprise draft with 4+ body sentences", async () => {
    nextDraft = {
      subject: "design partner slot",
      body: [
        "Regulated ops teams that pass audit on the first pass skip the manual trail.",
        "That's a real edge over category peers still doing it by hand.",
        "A short call would show how it maps to your control set.",
        "Open to a scoped design-partner conversation for Acme?",
      ].join(" "),
    };
    const out = await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, buyerType: "enterprise" }],
    });
    expect(out.drafted[0]?.flags).toContain("enterprise-too-many-sentences");
  });

  it("flags an enterprise draft whose first sentence is a personalised dossier observation", async () => {
    nextDraft = {
      subject: "design partner slot",
      body: [
        "I noticed your team just shipped a major platform migration.",
        "A short call would show the specific fit.",
        "Open to a scoped design-partner conversation?",
      ].join(" "),
    };
    const out = await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, buyerType: "enterprise" }],
    });
    expect(out.drafted[0]?.flags).toContain("enterprise-dossier-opener");
  });

  it("does not flag the identical draft under buyerType government", async () => {
    nextDraft = {
      subject: "design partner slot",
      body: [
        "I noticed your team just shipped a major platform migration.",
        "That's a real edge over category peers still doing it by hand.",
        "A short call would show how it maps to your control set.",
        "Open to a scoped design-partner conversation for Acme?",
      ].join(" "),
    };
    const out = await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, buyerType: "government" }],
    });
    expect(out.drafted[0]?.flags).not.toContain("enterprise-too-many-sentences");
    expect(out.drafted[0]?.flags).not.toContain("enterprise-dossier-opener");
    expect(out.drafted[0]?.flags).not.toContain("enterprise-body-too-long");
  });

  it("does not flag a compliant enterprise draft", async () => {
    nextDraft = {
      subject: "design partner slot",
      body: [
        "Regulated ops teams that pass audit on the first pass now skip the manual evidence trail entirely.",
        "A short call would show exactly how the trail maps to your own control set.",
        "Open to a scoped design-partner conversation for Acme?",
      ].join(" "),
    };
    const out = await runDesignPartnerLoi({
      dryRun: true,
      targets: [{ ...base, buyerType: "enterprise" }],
    });
    expect(out.drafted[0]?.flags).toEqual([]);
  });

  // Acceptance criterion (issue #707): a dry-run draft for an enterprise
  // VP-level target and a staff-engineer target both reach the prompt with
  // their own TITLE, and a compliant draft in EITHER register (a tighter
  // formal note for the VP, a shorter casual one for the staff engineer)
  // passes the same 3-sentence code-enforced cap — the register is a prompt
  // concern (title-keyed wording), the length cap is a code concern
  // (buyerType-keyed, title-independent). Run in this suite's isolated
  // ONESHOT_GTM_HOME (vitest.setup.ts redirects it to a fresh temp dir per
  // test file — never the developer's real ~/.oneshot-gtm).
  it("carries TITLE for both a VP-level and a staff-engineer enterprise target, and accepts a compliant 3-sentence draft in either register", async () => {
    const vpTarget = { ...base, buyerType: "enterprise", title: "VP of Engineering" };
    nextDraft = {
      subject: "design partner slot for acme",
      body: [
        "Regulated ops teams that pass audit on the first pass skip the manual evidence trail entirely.",
        "A short conversation would show exactly how that maps to your own control set.",
        "Open to a scoped design-partner conversation for Acme?",
      ].join(" "),
    };
    const vpOut = await runDesignPartnerLoi({ dryRun: true, targets: [vpTarget] });
    expect(calls.llmInputBlocks.at(-1)).toContain("TITLE: VP of Engineering");
    expect(vpOut.drafted[0]?.flags).toEqual([]);

    const icTarget = { ...base, buyerType: "enterprise", title: "Staff Engineer" };
    nextDraft = {
      subject: "quick question",
      body: [
        "Teams shipping agent tooling into regulated ops skip the manual evidence trail entirely.",
        "A short call would show how it maps to your stack.",
        "Open to a scoped design-partner chat?",
      ].join(" "),
    };
    const icOut = await runDesignPartnerLoi({ dryRun: true, targets: [icTarget] });
    expect(calls.llmInputBlocks.at(-1)).toContain("TITLE: Staff Engineer");
    expect(icOut.drafted[0]?.flags).toEqual([]);
  });
});

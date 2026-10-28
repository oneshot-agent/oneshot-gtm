import { beforeEach, describe, expect, it, vi } from "vitest";

// A candidate with no company domain is not dropped while the finder holds a
// profile: the LinkedIn profile names the employer's domain, or a GitHub / X
// dossier names a work email. Whatever comes back is still verified.

const { find, verify, readme, gate, enrich, research, breaker, events } = vi.hoisted(() => ({
  find: vi.fn(),
  verify: vi.fn(),
  readme: vi.fn(),
  gate: vi.fn(),
  enrich: vi.fn(),
  research: vi.fn(),
  breaker: { open: false, outcomes: [] as boolean[] },
  events: [] as Array<{ event: string; data: Record<string, unknown> }>,
}));
vi.mock("../src/_sdk-safe.ts", () => ({
  safeFindEmail: find,
  safeVerifyEmail: verify,
  safePeopleSearch: vi.fn(),
}));
vi.mock("../src/_github-readme.ts", () => ({ fetchProfileReadmeEmail: readme }));
vi.mock("../src/_breaker.ts", () => ({
  isCircuitOpen: () => breaker.open,
  recordResolutionOutcome: (isError: boolean) => breaker.outcomes.push(isError),
}));
vi.mock("../src/_enrich.ts", () => ({
  enrichVerifiedContact: async () => ({
    phone: null,
    linkedinUrl: null,
    title: null,
    summary: null,
    costUsd: 0,
  }),
}));
vi.mock("../src/_qualify.ts", () => ({ qualifyPostEnrich: gate }));
vi.mock("../src/_linkedin.ts", () => ({ findLinkedInUrl: vi.fn() }));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    enrichProfile: enrich,
    deepResearchPerson: research,
    // Short enough that a hung dossier times out inside the test.
    RESEARCH_DEADLINE_MS: 20,
    logEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  };
});

const { resolveVerifyEnrichQualify } = await import("../src/_contact.ts");

const base = {
  playName: "podcast-guest",
  fullName: "Ines Varga",
  companyDomain: null,
  icp: "founders",
  person: { name: "Ines Varga", company: null, roleText: "Founder" },
};
const LINKEDIN = "https://www.linkedin.com/in/ines-varga";

function profile(fields: Record<string, unknown>) {
  return { result: { status: "completed", profile: fields, cost: 0.02 }, receiptId: 3 };
}
function dossier(enrichment: Record<string, unknown>) {
  return { result: { status: "completed", result: { enrichment }, cost: 0.05 }, receiptId: 4 };
}
const fallbackEvents = () =>
  events.filter((e) => e.event === "finder.no_domain_fallback").map((e) => e.data);

beforeEach(() => {
  vi.resetAllMocks();
  breaker.open = false;
  breaker.outcomes = [];
  events.length = 0;
  gate.mockResolvedValue({
    action: "proceed",
    verdict: "pass",
    reason: "founder",
    roleText: "Founder",
    costUsd: 0,
  });
  find.mockResolvedValue({
    result: { status: "completed", found: true, email: "ines@quillworks.example", cost: 0.01 },
    receiptId: 1,
  });
  verify.mockResolvedValue({
    result: { status: "completed", deliverable: true, cost: 0.01 },
    receiptId: 2,
  });
  readme.mockResolvedValue({ status: "missing" });
});

describe("no-domain fallback in the contact step", () => {
  it("LinkedIn: the profile's employer domain feeds findEmail, then verify", async () => {
    enrich.mockResolvedValue(profile({ company_domain: "https://www.Quillworks.example/" }));
    const out = await resolveVerifyEnrichQualify({ ...base, linkedinUrlHint: LINKEDIN });
    expect(out).toMatchObject({ ok: true, channel: "email", email: "ines@quillworks.example" });
    expect(enrich).toHaveBeenCalledWith(
      { linkedinUrl: "https://www.linkedin.com/in/ines-varga" },
      expect.objectContaining({ playName: "podcast-guest" }),
    );
    expect(find).toHaveBeenCalledWith(
      { companyDomain: "quillworks.example", fullName: "Ines Varga" },
      expect.anything(),
    );
    expect(verify).toHaveBeenCalledWith({ email: "ines@quillworks.example" }, expect.anything());
    expect(research).not.toHaveBeenCalled();
    expect(out.costUsd).toBeCloseTo(0.04);
    expect(fallbackEvents()).toEqual([
      { name: "podcast-guest", via: "linkedin", outcome: "resolved" },
    ]);
  });

  it("LinkedIn: takes the enriched name and the primary role's website when the finder has neither", async () => {
    enrich.mockResolvedValue(
      profile({
        full_name: "Ines Varga",
        company_domain: null,
        experience: [
          { company: { website: "https://old-employer.com" } },
          { is_primary: true, company: { website: "https://quillworks.example/about" } },
        ],
      }),
    );
    const out = await resolveVerifyEnrichQualify({
      ...base,
      fullName: null,
      linkedinUrlHint: LINKEDIN,
    });
    expect(out).toMatchObject({
      ok: true,
      email: "ines@quillworks.example",
      fullName: "Ines Varga",
    });
    expect(find).toHaveBeenCalledWith(
      { companyDomain: "quillworks.example", fullName: "Ines Varga" },
      expect.anything(),
    );
  });

  it("GitHub only: the dossier's work email is verified and queued", async () => {
    research.mockResolvedValue(
      dossier({
        best_work_email: "Ines@Quillworks.example",
        best_personal_email: "ines@gmail.com",
      }),
    );
    const out = await resolveVerifyEnrichQualify({
      ...base,
      playName: "repo-interest",
      githubIdentity: { login: "ivarga", accountType: "User" },
    });
    expect(out).toMatchObject({ ok: true, channel: "email", email: "ines@quillworks.example" });
    expect(research).toHaveBeenCalledWith(
      { socialMediaUrl: "https://github.com/ivarga", name: "Ines Varga" },
      expect.objectContaining({ playName: "repo-interest" }),
    );
    // The free README pass runs first.
    expect(readme.mock.invocationCallOrder[0]).toBeLessThan(research.mock.invocationCallOrder[0]!);
    expect(verify).toHaveBeenCalledWith({ email: "ines@quillworks.example" }, expect.anything());
    expect(find).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    expect(out.costUsd).toBeCloseTo(0.06);
    expect(fallbackEvents()).toEqual([
      { name: "repo-interest", via: "github", outcome: "resolved" },
    ]);
  });

  it("X only: the handle becomes an x.com profile URL for the dossier", async () => {
    research.mockResolvedValue(dossier({ best_work_email: "ines@quillworks.example" }));
    const out = await resolveVerifyEnrichQualify({ ...base, xHandleHint: "@ivarga_builds" });
    expect(out).toMatchObject({ ok: true, email: "ines@quillworks.example" });
    expect(research).toHaveBeenCalledWith(
      expect.objectContaining({ socialMediaUrl: "https://x.com/ivarga_builds" }),
      expect.anything(),
    );
  });

  it("a personal address on the dossier is never used", async () => {
    research.mockResolvedValue(
      dossier({
        best_work_email: null,
        email: "ines.varga@gmail.com",
        altemails: ["iv@proton.me"],
      }),
    );
    const out = await resolveVerifyEnrichQualify({
      ...base,
      githubIdentity: { login: "ivarga" },
    });
    expect(out).toMatchObject({ ok: false, reason: "no-domain" });
    expect(verify).not.toHaveBeenCalled();
    expect(out.costUsd).toBeCloseTo(0.05);
  });

  it("nothing to go on: still no-domain, no paid calls", async () => {
    const out = await resolveVerifyEnrichQualify(base);
    expect(out).toMatchObject({ ok: false, reason: "no-domain", costUsd: 0 });
    expect(enrich).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(fallbackEvents()).toEqual([]);
  });

  it("a junk employer domain is a miss, and no dossier without a GitHub or X identity", async () => {
    enrich.mockResolvedValue(profile({ company_domain: "ivarga.github.io" }));
    const out = await resolveVerifyEnrichQualify({ ...base, linkedinUrlHint: LINKEDIN });
    expect(out).toMatchObject({ ok: false, reason: "no-domain" });
    expect(out.costUsd).toBeCloseTo(0.02);
    expect(find).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(fallbackEvents()).toEqual([
      { name: "podcast-guest", via: "linkedin", outcome: "miss", reason: "no-domain" },
    ]);
  });

  it("an empty LinkedIn profile falls through to the dossier when a GitHub identity exists", async () => {
    enrich.mockResolvedValue(profile({ company_domain: null }));
    research.mockResolvedValue(dossier({ best_work_email: "ines@quillworks.example" }));
    const out = await resolveVerifyEnrichQualify({
      ...base,
      linkedinUrlHint: LINKEDIN,
      githubIdentity: { login: "ivarga" },
    });
    expect(out).toMatchObject({ ok: true, email: "ines@quillworks.example" });
    expect(out.costUsd).toBeCloseTo(0.08);
    expect(fallbackEvents().map((e) => [e.via, e.outcome])).toEqual([
      ["linkedin", "miss"],
      ["github", "resolved"],
    ]);
  });

  it("a dossier that times out is the original no-domain miss, not an outage", async () => {
    research.mockReturnValue(new Promise(() => {}));
    const out = await resolveVerifyEnrichQualify({ ...base, githubIdentity: { login: "ivarga" } });
    expect(out).toMatchObject({ ok: false, reason: "no-domain", costUsd: 0 });
    expect(breaker.outcomes).not.toContain(true);
  });

  it("an empty dossier is the original no-domain miss", async () => {
    research.mockResolvedValue(dossier({}));
    const out = await resolveVerifyEnrichQualify({ ...base, xHandleHint: "ivarga_builds" });
    expect(out).toMatchObject({ ok: false, reason: "no-domain" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("a dossier that throws is a platform error and feeds the breaker", async () => {
    research.mockRejectedValue(new Error("502 bad gateway"));
    const out = await resolveVerifyEnrichQualify({ ...base, githubIdentity: { login: "ivarga" } });
    expect(out).toMatchObject({ ok: false, reason: "platform-error" });
    expect(breaker.outcomes).toContain(true);
  });

  it("a dossier that finds nobody is the original no-domain miss and spares the breaker", async () => {
    research.mockRejectedValue(
      new Error("Job failed: Could not find data for this person or company."),
    );
    const out = await resolveVerifyEnrichQualify({ ...base, githubIdentity: { login: "ivarga" } });
    expect(out).toMatchObject({ ok: false, reason: "no-domain" });
    expect(breaker.outcomes).not.toContain(true);
    // The backend answered, so the verdict ends any run of platform errors.
    expect(breaker.outcomes).toContain(false);
    expect(events).toContainEqual({
      event: "finder.no_domain_fallback",
      data: expect.objectContaining({ via: "github", outcome: "miss" }),
    });
  });

  it("an enrichProfile that finds nobody falls through to the dossier", async () => {
    enrich.mockRejectedValue(new Error("Job failed: Could not find data for this person."));
    research.mockResolvedValue(dossier({ best_work_email: "ines@halyard.example" }));
    const out = await resolveVerifyEnrichQualify({
      ...base,
      linkedinUrlHint: LINKEDIN,
      githubIdentity: { login: "ivarga" },
    });
    expect(research).toHaveBeenCalled();
    expect(breaker.outcomes).not.toContain(true);
    expect(out).not.toMatchObject({ reason: "platform-error" });
  });

  it("an enrichProfile that finds nobody ends a run of platform errors", async () => {
    enrich.mockRejectedValue(new Error("Job failed: Could not find data for this person."));
    const out = await resolveVerifyEnrichQualify({ ...base, linkedinUrlHint: LINKEDIN });
    expect(out).toMatchObject({ ok: false, reason: "no-domain" });
    expect(breaker.outcomes).toEqual([false]);
  });

  it("an enrichProfile that throws is a platform error, never a fall-through to the dossier", async () => {
    enrich.mockRejectedValue(new Error("socket hang up"));
    const out = await resolveVerifyEnrichQualify({
      ...base,
      linkedinUrlHint: LINKEDIN,
      githubIdentity: { login: "ivarga" },
    });
    expect(out).toMatchObject({ ok: false, reason: "platform-error" });
    expect(research).not.toHaveBeenCalled();
  });

  it("an open breaker skips the paid lookups", async () => {
    breaker.open = true;
    const out = await resolveVerifyEnrichQualify({ ...base, linkedinUrlHint: LINKEDIN });
    expect(out).toMatchObject({ ok: false, reason: "platform-error" });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("the duplicate check applies to the address the fallback found", async () => {
    research.mockResolvedValue(dossier({ best_work_email: "ines@quillworks.example" }));
    const seen: string[] = [];
    const out = await resolveVerifyEnrichQualify({
      ...base,
      githubIdentity: { login: "ivarga" },
      isDuplicate: (email) => {
        seen.push(email);
        return true;
      },
    });
    expect(out).toMatchObject({ ok: false, reason: "duplicate" });
    expect(seen).toEqual(["ines@quillworks.example"]);
    expect(verify).not.toHaveBeenCalled();
  });

  it("an undeliverable fallback address is a miss the channel walk moves past", async () => {
    enrich.mockResolvedValue(profile({ company_domain: "quillworks.example" }));
    verify.mockResolvedValue({
      result: { status: "completed", deliverable: false, cost: 0.01 },
      receiptId: 2,
    });
    const out = await resolveVerifyEnrichQualify({ ...base, linkedinUrlHint: LINKEDIN });
    expect(out).toMatchObject({ ok: false, reason: "undeliverable" });
    expect(out.costUsd).toBeCloseTo(0.04);
  });
});

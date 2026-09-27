import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared contact step walks the run's channel order: the first channel a
// person has an address on wins. Email misses fall through to LinkedIn;
// LinkedIn-first never pays for an email lookup.

const { find, verify, gate, linkedinSearch } = vi.hoisted(() => ({
  find: vi.fn(),
  verify: vi.fn(),
  gate: vi.fn(),
  linkedinSearch: vi.fn(),
}));
vi.mock("../src/_sdk-safe.ts", () => ({
  safeFindEmail: find,
  safeVerifyEmail: verify,
  safePeopleSearch: vi.fn(),
}));
vi.mock("../src/_github-readme.ts", () => ({ fetchProfileReadmeEmail: vi.fn() }));
vi.mock("../src/_breaker.ts", () => ({
  isCircuitOpen: () => false,
  recordResolutionOutcome: () => {},
}));
vi.mock("../src/_findemail-prescreen.ts", () => ({ shouldSkipFindEmail: () => ({ ok: true }) }));
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
vi.mock("../src/_linkedin.ts", () => ({ findLinkedInUrl: linkedinSearch }));
const { profileKnown } = vi.hoisted(() => ({ profileKnown: { value: false } }));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({ isLinkedInProfileKnown: () => profileKnown.value }),
  };
});

const { resolveVerifyEnrichQualify } = await import("../src/_contact.ts");
const { withFinderChannels, parseChannels } = await import("../src/_channels-context.ts");

const base = {
  playName: "luma-events",
  fullName: "Dana Lee",
  companyDomain: "acme.com",
  icp: "founders",
  person: { name: "Dana Lee", company: "Acme", roleText: "Founder" },
};

beforeEach(() => {
  vi.resetAllMocks();
  profileKnown.value = false;
  gate.mockResolvedValue({
    action: "proceed",
    verdict: "pass",
    reason: "founder",
    roleText: "Founder",
    costUsd: 0,
  });
  find.mockResolvedValue({
    result: { status: "completed", found: true, email: "dana@acme.com", cost: 0.01 },
    receiptId: 1,
  });
  verify.mockResolvedValue({
    result: { status: "completed", deliverable: true, cost: 0.01 },
    receiptId: 2,
  });
  linkedinSearch.mockResolvedValue("https://www.linkedin.com/in/dana-lee");
});

describe("channel order in the contact step", () => {
  it("email only by default", async () => {
    const out = await resolveVerifyEnrichQualify(base);
    expect(out).toMatchObject({ ok: true, channel: "email", email: "dana@acme.com" });
    expect(linkedinSearch).not.toHaveBeenCalled();
  });

  it("falls through to LinkedIn when no email is found", async () => {
    find.mockResolvedValue({
      result: { status: "completed", found: false, cost: 0.01 },
      receiptId: 1,
    });
    const out = await resolveVerifyEnrichQualify({
      ...base,
      channels: ["email", "linkedin"],
      linkedinUrlHint: "https://www.linkedin.com/in/dana-lee",
    });
    expect(out).toMatchObject({
      ok: true,
      channel: "linkedin",
      email: null,
      linkedinUrl: "https://www.linkedin.com/in/dana-lee",
      verdict: "pass",
    });
    expect(linkedinSearch).not.toHaveBeenCalled();
    expect(out.costUsd).toBeCloseTo(0.01);
  });

  it("LinkedIn first never pays for an email lookup, and searches when the finder has no URL", async () => {
    const out = await resolveVerifyEnrichQualify({ ...base, channels: ["linkedin", "email"] });
    expect(out).toMatchObject({ ok: true, channel: "linkedin" });
    expect(find).not.toHaveBeenCalled();
    expect(linkedinSearch).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: "Dana Lee", disambiguators: ["Acme"] }),
    );
  });

  it("moves on to email when LinkedIn has no profile", async () => {
    linkedinSearch.mockResolvedValue(null);
    const out = await resolveVerifyEnrichQualify({ ...base, channels: ["linkedin", "email"] });
    expect(out).toMatchObject({ ok: true, channel: "email", email: "dana@acme.com" });
  });

  it("a duplicate email stops the walk instead of queueing the person on LinkedIn", async () => {
    const out = await resolveVerifyEnrichQualify({
      ...base,
      channels: ["email", "linkedin"],
      isDuplicate: () => true,
    });
    expect(out).toMatchObject({ ok: false, reason: "duplicate" });
    expect(linkedinSearch).not.toHaveBeenCalled();
  });

  it("the person gate still decides on the LinkedIn channel", async () => {
    gate.mockResolvedValue({ action: "reject", reason: "intern", costUsd: 0 });
    const out = await resolveVerifyEnrichQualify({ ...base, channels: ["linkedin"] });
    expect(out).toMatchObject({ ok: false, reason: "role", detail: "intern" });
  });

  it("a profile already known or queued in any play is a duplicate on LinkedIn", async () => {
    profileKnown.value = true;
    const out = await resolveVerifyEnrichQualify({ ...base, channels: ["linkedin"] });
    expect(out).toMatchObject({ ok: false, reason: "duplicate" });
    expect(gate).not.toHaveBeenCalled();
  });

  it("a LinkedIn lookup that could not run is an outage, not a miss", async () => {
    linkedinSearch.mockImplementation(async (a: { onUnavailable?: () => void }) => {
      a.onUnavailable?.();
      return null;
    });
    const out = await resolveVerifyEnrichQualify({ ...base, channels: ["linkedin", "email"] });
    expect(out).toMatchObject({ ok: false, reason: "platform-error" });
    expect(find).not.toHaveBeenCalled();
  });

  it("reports the email miss when no channel works", async () => {
    find.mockResolvedValue({
      result: { status: "completed", found: false, cost: 0 },
      receiptId: 1,
    });
    linkedinSearch.mockResolvedValue(null);
    const out = await resolveVerifyEnrichQualify({ ...base, channels: ["email", "linkedin"] });
    expect(out).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("uses the trigger run's channel order when the caller passes none", async () => {
    find.mockResolvedValue({
      result: { status: "completed", found: false, cost: 0 },
      receiptId: 1,
    });
    const out = await withFinderChannels(parseChannels(["email", "linkedin"]), () =>
      resolveVerifyEnrichQualify(base),
    );
    expect(out).toMatchObject({ ok: true, channel: "linkedin" });
  });
});

describe("parseChannels", () => {
  it("keeps known channels in order, once", () => {
    expect(parseChannels(["linkedin", "email", "linkedin", "fax"])).toEqual(["linkedin", "email"]);
    expect(parseChannels([])).toBeNull();
    expect(parseChannels("email")).toBeNull();
  });
});

describe("the X channel", () => {
  it("queues on X when the finder has a handle and email has no address", async () => {
    find.mockResolvedValue({
      result: { status: "completed", found: false, cost: 0 },
      receiptId: 1,
    });
    const out = await resolveVerifyEnrichQualify({
      ...base,
      channels: ["email", "x"],
      xHandleHint: "https://x.com/dana_lee",
    });
    expect(out).toMatchObject({ ok: true, channel: "x", email: null, xHandle: "dana_lee" });
  });

  it("moves on when there is no handle — the contact step never searches X", async () => {
    const out = await resolveVerifyEnrichQualify({ ...base, channels: ["x", "email"] });
    expect(out).toMatchObject({ ok: true, channel: "email" });
  });
});

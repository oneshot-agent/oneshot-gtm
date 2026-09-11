import { beforeEach, describe, expect, it, vi } from "vitest";

// Person research on queue rows and prospects: the current role from the
// LinkedIn history, the finder's originals kept, the gate re-judged on real
// facts, guarded writes. The Julia fixture is row #9144 (2026-09-11): guest
// list said "| Curious Explorer" at L'eto Group; LinkedIn said Founder &
// Product Owner at WildMuse.App since Mar 2026, L'ETO ended Oct 2025.

const calls = { research: 0, company: 0, classify: 0, webRead: 0 };
const patches: Array<{ id: number; patch: Record<string, unknown> }> = [];
const notes: Array<{ id: number; notes: string }> = [];
const statuses: Array<Record<string, unknown>> = [];
const priorities: Array<{ id: number; priority: unknown }> = [];
const prospectWrites: Array<Record<string, unknown>> = [];
const productCache = new Map<string, string>();
let enrichmentCache: { result_json: string; fetched_at: string; status: string } | null = null;
let liveRows = new Set<number>([1, 2]);
let icp: string | null = "founders who own their own customer acquisition";
let verdict = '{"verdict":"pass","reason":"Founder of a consumer app, owns acquisition."}';
let researchStatus = "completed";
let pendingRows: unknown[] = [];

const juliaResearch = {
  status: "completed",
  result: {
    enrichment: {
      bio: "Solo-built consumer wellness app from 0 to first revenue.",
      location: "London",
      best_work_email: "julia@wildmuse.app",
      organizations: [
        {
          name: "Julia's Consultancy",
          title: "Business Consultant",
          startDate: "Oct 2022",
          endDate: "Nov 2024",
          endDate_formatted: { is_current: false },
        },
        {
          name: "WildMuse.App",
          title: "Founder & Product Owner",
          startDate: "Mar 2026",
          endDate_formatted: { is_current: true },
        },
        {
          name: "L'ETO Group",
          title: "Head of Product and Business Development Manager",
          startDate: "Nov 2024",
          endDate: "Oct 2025",
          endDate_formatted: { is_current: false },
        },
      ],
    },
  },
  cost: 0.05,
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), icpOneLiner: icp }),
    logEvent: () => {},
    getLedger: () => ({
      getCachedEnrichment: () => enrichmentCache,
      setCachedEnrichment: () => {},
      setCachedEnrichmentFailure: () => {},
      getProductResearchCache: (key: string) => productCache.get(key) ?? null,
      setProductResearchCache: (key: string, value: string) => productCache.set(key, value),
      patchLiveQueuePayload: (input: { id: number; patch: Record<string, unknown> }) => {
        if (!liveRows.has(input.id)) return false;
        patches.push(input);
        return true;
      },
      setQueueNotes: (input: { id: number; notes: string }) => notes.push(input),
      setQueueStatus: (input: Record<string, unknown>) => statuses.push(input),
      setQueuePriority: (id: number, priority: unknown) => priorities.push({ id, priority }),
      getProspectById: () => null,
      listPendingQueueAfterId: () => pendingRows,
      mergeProspectDossierHalf: (id: number, half: string, value: unknown, slice?: number) =>
        prospectWrites.push({ kind: "dossier", id, half, value, slice }),
      setProspectCurrentRole: (id: number, patch: unknown) =>
        prospectWrites.push({ kind: "role", id, patch }),
      setProspectIcpVerdict: (id: number, v: string, reason: string | null) =>
        prospectWrites.push({ kind: "verdict", id, verdict: v, reason }),
    }),
    deepResearchPerson: async () => {
      calls.research++;
      return { result: { ...juliaResearch, status: researchStatus }, receiptId: 7 };
    },
    enrichCompany: async () => {
      calls.company++;
      return {
        result: {
          status: "completed",
          company: {
            name: "WildMuse.App",
            domain: "wildmuse.app",
            industry: "Software",
            employee_count: 3,
            founded: 2026,
            description: "Consumer wellness app.",
          },
          cost: 0.005,
        },
        receiptId: 8,
      };
    },
    webRead: async ({ url }: { url: string }) => {
      calls.webRead++;
      return { result: { markdown: `first-party ${url}`, cost: 0.01 }, receiptId: 9 };
    },
    deepResearch: async () => ({
      result: { answer: "Consumer wellness app.", sources: [], cost: 0.05 },
      receiptId: 10,
    }),
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async () => {
      calls.classify++;
      return { content: verdict, provider: "t", model: "t" };
    },
  };
});

const {
  applyPersonResearch,
  applyPersonResearchToProspect,
  deriveCurrentRole,
  normalizeCompany,
  organizationsFromResearch,
  parsePeriod,
  personPayloadPatch,
  personSeedFor,
  personSeedForProspect,
  rejudgePerson,
  researchNewQueueRowPeople,
  researchPerson,
} = await import("../src/_person-research.ts");

const juliaPayload = {
  name: "Julia Zabrodska",
  email: "julia.zabrodska@letocaffe.com",
  company: "L'eto Group",
  companyDomain: "letocaffe.com",
  title: "| Curious Explorer",
  attendeeBio: "Newbie in InfoSec.",
  linkedinUrl: "https://www.linkedin.com/in/julia-zabrodska-akinci-cv/",
  eventTitle: "AI Pilled [Builder] #03",
  icpVerdict: "unclear",
  icpVerdictReason: "unclear-after-enrich: Role text is a personal-brand slogan.",
  fitReason: "Role text is a personal-brand slogan rather than a job function.",
  productResearch: { version: 1, status: "partial", researchedAt: "x", subject: {}, sources: [] },
};

const row = (id: number, status: "pending" | "approved") => ({
  id,
  play_name: "luma-events",
  source: "find:luma-events",
  notes: "Julia Zabrodska going to AI Pilled [Builder] #03",
  payload_json: JSON.stringify(juliaPayload),
  status,
  prospect_id: null,
});

beforeEach(() => {
  calls.research = calls.company = calls.classify = calls.webRead = 0;
  patches.length = notes.length = statuses.length = priorities.length = prospectWrites.length = 0;
  productCache.clear();
  enrichmentCache = null;
  liveRows = new Set([1, 2]);
  icp = "founders who own their own customer acquisition";
  verdict = '{"verdict":"pass","reason":"Founder of a consumer app, owns acquisition."}';
  researchStatus = "completed";
  pendingRows = [];
});

describe("deriveCurrentRole", () => {
  it("is_current wins, then the latest start among current entries; the history is current-first", () => {
    const { current, organizations } = deriveCurrentRole([
      { name: "Old", startDate: "2019", endDate: "2021", current: false },
      { name: "A", startDate: "2023-01", current: true },
      { name: "B", startDate: "Mar 2026", current: true },
    ]);
    expect(current?.name).toBe("B");
    expect(organizations.map((o) => o.name)).toEqual(["B", "A", "Old"]);
  });

  it("no current entry means no role: the last job someone left is not where they work", () => {
    expect(deriveCurrentRole([{ name: "X", endDate: "2024", current: false }]).current).toBeNull();
    expect(deriveCurrentRole([]).current).toBeNull();
  });

  it("unparseable dates keep the provider's order", () => {
    const { current } = deriveCurrentRole([
      { name: "First", startDate: "long ago", current: true },
      { name: "Second", startDate: "recently", current: true },
    ]);
    expect(current?.name).toBe("First");
  });
});

describe("organizationsFromResearch", () => {
  it("reads the enrich-style shape: period strings, and a dated experience entry beats the headline's dateless one", () => {
    // The shape row #9144's research actually returned (2026-09-11).
    const orgs = organizationsFromResearch({
      status: "completed",
      result: {
        title: "| Curious Explorer",
        company: "L'eto Group",
        experience: [
          {
            title: "Head of Product and Business Development Manager",
            company: "L'eto Group",
            period: "Nov 2024 - Present",
            company_website: "https://letocaffe.com",
          },
          {
            title: "Business Consultant",
            company: "Julia's Consultancy",
            period: "Oct 2022 - Nov 2024",
          },
        ],
        enrichment: {
          title: "| Curious Explorer",
          company: "L'eto Group",
          experience: [
            {
              title: "Head of Product and Business Development Manager",
              company: "L'eto Group",
              period: "Nov 2024 - Present",
            },
          ],
          organizations: [{ name: "L'eto Group", title: "| Curious Explorer" }],
        },
      },
    });
    expect(orgs).toEqual([
      {
        name: "L'eto Group",
        title: "Head of Product and Business Development Manager",
        startDate: "Nov 2024",
        current: true,
      },
      {
        name: "Julia's Consultancy",
        title: "Business Consultant",
        startDate: "Oct 2022",
        endDate: "Nov 2024",
        current: false,
      },
    ]);
    expect(deriveCurrentRole(orgs).current?.title).toBe(
      "Head of Product and Business Development Manager",
    );
    expect(parsePeriod("2019 - 2021")).toEqual({
      startDate: "2019",
      endDate: "2021",
      current: false,
    });
    expect(parsePeriod("Mar 2026 -")).toEqual({ startDate: "Mar 2026", current: true });
  });
});

describe("normalizeCompany / personSeedFor", () => {
  it("ignores case, punctuation and legal suffixes", () => {
    expect(normalizeCompany("L'eto Group")).toBe(normalizeCompany("L'ETO"));
    expect(normalizeCompany("Acme, Inc.")).toBe(normalizeCompany("ACME"));
    expect(normalizeCompany("WildMuse.App")).not.toBe(normalizeCompany("L'ETO Group"));
  });

  it("seeds from a normalised LinkedIn URL, else email + name, else nothing", () => {
    expect(personSeedFor(juliaPayload)?.url).toBe(
      "https://linkedin.com/in/julia-zabrodska-akinci-cv",
    );
    expect(personSeedFor({ email: "a@b.dev", name: "Ann" })).toMatchObject({
      url: null,
      email: "a@b.dev",
    });
    expect(personSeedFor({ email: "a@b.dev" })).toBeNull();
    expect(
      personSeedFor({ name: "Ann", sourceProfileUrl: "https://luma.com/user/ann" }),
    ).toBeNull();
  });
});

describe("researchPerson + personPayloadPatch", () => {
  it("resolves the current role, buys the company record, and corrects the row while keeping the finder's originals", async () => {
    const { dossier, costUsd } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: Number.POSITIVE_INFINITY,
    });
    expect(dossier.status).toBe("complete");
    expect(dossier.currentRole).toEqual({
      title: "Founder & Product Owner",
      company: "WildMuse.App",
      since: "Mar 2026",
    });
    expect(dossier.organizations.map((o) => o.name)).toEqual([
      "WildMuse.App",
      "L'ETO Group",
      "Julia's Consultancy",
    ]);
    expect(dossier.company).toMatchObject({
      domain: "wildmuse.app",
      employeeCount: 3,
      founded: 2026,
    });
    expect(dossier.workEmail).toBe("julia@wildmuse.app");
    expect(costUsd).toBeCloseTo(0.055, 5);
    expect(calls).toMatchObject({ research: 1, company: 1 });

    const patch = personPayloadPatch(juliaPayload, dossier);
    expect(patch.title).toBe("Founder & Product Owner");
    expect(patch.titleAtFinder).toBe("| Curious Explorer");
    expect(patch.company).toBe("WildMuse.App");
    expect(patch.companyAtFinder).toBe("L'eto Group");
    expect(patch.companyDomain).toBe("wildmuse.app");
    expect(patch.companyDomainAtFinder).toBe("letocaffe.com");
    expect(patch.productResearch).toBeNull();
    expect(patch.currentRole).toBe("Founder & Product Owner at WildMuse.App since Mar 2026");
    expect(patch.companyFacts).toContain("founded 2026");
    expect(patch.formerRoles).toContain("L'ETO Group (Nov 2024–Oct 2025)");
  });

  it("a case-only company difference is not a change, and originals are never overwritten on refresh", async () => {
    const { dossier } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    const same = personPayloadPatch(
      {
        ...juliaPayload,
        company: "WILDMUSE.APP",
        title: "Founder & Product Owner",
        companyDomain: "wildmuse.app",
      },
      dossier,
    );
    expect(same.company).toBeUndefined();
    expect(same.title).toBeUndefined();
    expect(same.companyAtFinder).toBeUndefined();
    const refreshed = personPayloadPatch(
      { ...juliaPayload, titleAtFinder: "the original", companyAtFinder: "the original co" },
      dossier,
    );
    expect(refreshed.title).toBe("Founder & Product Owner");
    expect(refreshed.titleAtFinder).toBeUndefined();
    expect(refreshed.companyAtFinder).toBeUndefined();
  });

  it("the cost cap stops the paid call before it starts; a cache hit is free", async () => {
    const capped = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 0.01,
    });
    expect(capped.dossier.status).toBe("unavailable");
    expect(capped.dossier.warning).toContain("cost cap");
    expect(calls.research).toBe(0);

    enrichmentCache = {
      result_json: JSON.stringify(juliaResearch),
      fetched_at: new Date().toISOString(),
      status: "ok",
    };
    const cached = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
      enrichCompany: false,
    });
    expect(cached.cached).toBe(true);
    expect(cached.costUsd).toBe(0);
    expect(cached.dossier.status).toBe("partial");
    expect(calls.research).toBe(0);
  });

  it("a failed research call is unavailable, not a row change", async () => {
    researchStatus = "failed";
    const { dossier } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    expect(dossier.status).toBe("unavailable");
    expect(personPayloadPatch(juliaPayload, dossier)).toEqual({ personResearch: dossier });
  });
});

describe("rejudgePerson", () => {
  it("re-judges on the researched role and refreshes the fit line on pass", async () => {
    const { dossier } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    const patch = personPayloadPatch(juliaPayload, dossier);
    const judged = await rejudgePerson({
      playName: "luma-events",
      payload: juliaPayload,
      patch,
      icp,
    });
    expect(judged.verdict).toBe("pass");
    expect(judged.patch).toMatchObject({
      icpVerdict: "pass",
      fitReason: "Founder of a consumer app, owns acquisition.",
      fitReasonSource: "person-gate",
    });
    expect(calls.classify).toBe(1);
  });

  it("skips the classifier when the verdict was already pass and nothing changed", async () => {
    const { dossier } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    calls.classify = 0;
    const settled = {
      ...juliaPayload,
      icpVerdict: "pass",
      title: "Founder & Product Owner",
      company: "WildMuse.App",
      companyDomain: "wildmuse.app",
    };
    const judged = await rejudgePerson({
      playName: "luma-events",
      payload: settled,
      patch: personPayloadPatch(settled, dossier),
      icp,
    });
    expect(judged.verdict).toBeNull();
    expect(calls.classify).toBe(0);
  });
});

describe("applyPersonResearch (queue rows)", () => {
  async function dossierFor() {
    const { dossier } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    return dossier;
  }

  it("patches through the guarded write, re-scores, and re-runs product research for the new domain", async () => {
    const dossier = await dossierFor();
    const ledger = (await import("@oneshot-gtm/core")).getLedger();
    const out = await applyPersonResearch(ledger, row(1, "approved"), dossier, {
      rejudge: true,
      icp,
      remainingUsd: 1,
    });
    expect(out.outcome).toBe("patched");
    expect(out.verdict).toBe("pass");
    expect(patches[0]).toMatchObject({
      id: 1,
      patch: expect.objectContaining({
        title: "Founder & Product Owner",
        titleAtFinder: "| Curious Explorer",
        icpVerdict: "pass",
        productResearch: null,
      }),
    });
    expect(priorities).toHaveLength(1);
    // Second patch: the product research re-run for wildmuse.app.
    expect(calls.webRead).toBeGreaterThan(0);
    expect(patches[1]?.patch["productResearch"]).toMatchObject({ version: 1 });
    expect(statuses).toHaveLength(0);
  });

  it("a reject on a pending row rejects it like the finder would; on an approved row it only notes", async () => {
    verdict = '{"verdict":"reject","reason":"Consumer wellness app founder, no business buyer."}';
    const dossier = await dossierFor();
    const ledger = (await import("@oneshot-gtm/core")).getLedger();
    const pending = await applyPersonResearch(ledger, row(1, "pending"), dossier, {
      rejudge: true,
      icp,
      remainingUsd: 1,
    });
    expect(pending.outcome).toBe("rejected");
    expect(statuses[0]).toMatchObject({ id: 1, status: "rejected" });
    expect(String(statuses[0]?.notes)).toMatch(/^auto: role — Consumer wellness/);

    const approved = await applyPersonResearch(ledger, row(2, "approved"), dossier, {
      rejudge: true,
      icp,
      remainingUsd: 1,
    });
    expect(approved.outcome).toBe("patched");
    expect(statuses).toHaveLength(1);
    expect(notes.at(-1)?.notes).toContain("re-judged after research: Consumer wellness");
    expect(patches.find((p) => p.id === 2)?.patch["icpVerdict"]).toBe("reject");
  });

  it("a row that is no longer live is skipped, never rejected", async () => {
    verdict = '{"verdict":"reject","reason":"no"}';
    liveRows = new Set();
    const dossier = await dossierFor();
    const ledger = (await import("@oneshot-gtm/core")).getLedger();
    const out = await applyPersonResearch(ledger, row(1, "pending"), dossier, {
      rejudge: true,
      icp,
      remainingUsd: 1,
    });
    expect(out.outcome).toBe("skipped");
    expect(statuses).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("an unavailable result is recorded on the row with a note, and nothing else changes", async () => {
    researchStatus = "failed";
    const dossier = await dossierFor();
    const ledger = (await import("@oneshot-gtm/core")).getLedger();
    const out = await applyPersonResearch(ledger, row(1, "pending"), dossier, {
      rejudge: true,
      icp,
      remainingUsd: 1,
    });
    expect(out.outcome).toBe("unavailable");
    expect(patches[0]?.patch).toEqual({ personResearch: dossier });
    expect(notes[0]?.notes).toContain("person research unavailable");
    expect(calls.classify).toBe(0);
  });
});

describe("researchNewQueueRowPeople", () => {
  it("skips rows that already carry research or have nothing to research; own-source only", async () => {
    pendingRows = [
      { ...row(1, "pending") },
      {
        ...row(2, "pending"),
        payload_json: JSON.stringify({
          ...juliaPayload,
          personResearch: {
            version: 1,
            status: "partial",
            researchedAt: "x",
            seed: {},
            organizations: [],
            costUsd: 0,
            cached: false,
          },
        }),
      },
      { ...row(3, "pending"), payload_json: JSON.stringify({ name: "Nobody" }) },
      { ...row(4, "pending"), source: "find:github-stars" },
    ];
    const result = { source: "find:luma-events", costUsd: 0.4, enqueued: 4, sdkCostUsd: 0.4 };
    await researchNewQueueRowPeople({
      afterId: 0,
      result: result as never,
      enabled: true,
      maxCostUsd: 10,
    });
    expect(calls.research).toBe(1);
    expect(patches.map((p) => p.id)).toEqual([1, 1]);
    expect(result.costUsd).toBeCloseTo(0.4 + 0.055 + 0.01 + 0.05, 3);
  });

  it("does nothing when disabled or when the cap is already spent", async () => {
    pendingRows = [row(1, "pending")];
    const result = { source: "find:luma-events", costUsd: 5, enqueued: 1 };
    await researchNewQueueRowPeople({ afterId: 0, result: result as never, enabled: false });
    await researchNewQueueRowPeople({
      afterId: 0,
      result: result as never,
      enabled: true,
      maxCostUsd: 5,
    });
    expect(calls.research).toBe(0);
  });
});

describe("applyPersonResearchToProspect", () => {
  it("writes the person half, corrects title and company, and re-judges the stored verdict", async () => {
    const prospect = {
      id: 611,
      name: "Julia Zabrodska",
      company: "L'eto Group",
      email: "julia.zabrodska@letocaffe.com",
      source: "luma-events",
      source_profile_url: null,
      linkedin_url: "https://www.linkedin.com/in/julia-zabrodska-akinci-cv",
      dossier_json: JSON.stringify({
        person: { status: "completed", profile: { title: "| Curious Explorer" } },
        product: { version: 1, status: "partial", researchedAt: "x", subject: {}, sources: [] },
      }),
      title: "| Curious Explorer",
      icp_verdict: "unclear",
    };
    const { dossier } = await researchPerson({
      seed: personSeedForProspect(prospect),
      playName: "research-prospects",
      subject: { prospectId: 611 },
      remainingUsd: 1,
    });
    const ledger = (await import("@oneshot-gtm/core")).getLedger();
    const out = await applyPersonResearchToProspect(ledger, prospect, dossier, {
      rejudge: true,
      icp,
      dossierSlice: 6000,
    });
    expect(out).toEqual({ outcome: "written", verdict: "pass", roleChanged: true });
    const dossierWrite = prospectWrites.find((w) => w["kind"] === "dossier") as Record<
      string,
      unknown
    >;
    expect(dossierWrite["half"]).toBe("person");
    const half = dossierWrite["value"] as Record<string, unknown>;
    expect(half["title"]).toBe("Founder & Product Owner");
    expect((half["enrichment"] as Record<string, unknown>)["status"]).toBe("completed");
    expect(prospectWrites.find((w) => w["kind"] === "role")).toMatchObject({
      id: 611,
      patch: { title: "Founder & Product Owner", company: "WildMuse.App" },
    });
    expect(prospectWrites.find((w) => w["kind"] === "verdict")).toMatchObject({ verdict: "pass" });
  });
});

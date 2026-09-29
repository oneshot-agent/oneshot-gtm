import { beforeEach, describe, expect, it, vi } from "vitest";

// Person research on queue rows and prospects: the current role from the
// LinkedIn history, the finder's originals kept, the gate re-judged on real
// facts, guarded writes. The Julia fixture is row #9144 (2026-09-11): guest
// list said "| Curious Explorer" at L'eto Group; LinkedIn said Founder &
// Product Owner at WildMuse.App since Mar 2026, L'ETO ended Oct 2025.

const calls = { research: 0, company: 0, classify: 0, webRead: 0, browser: 0 };
let lastClassifierInput = "";
let liveSession = false;
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
/** What the provider names the person for a URL seed / an email seed (null = no name field). */
let providerNameByUrl: string | null = null;
let providerNameByEmail: string | null = null;
let liveName = "Julia Zabrodska-Akinci";
let pendingRows: unknown[] = [];
/** The provider's top-level `linkedin_url` (null = the field is absent). */
let providerLinkedIn: string | null = null;

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
    loadConfig: () => ({
      ...actual.loadConfig(),
      icpOneLiner: icp,
      linkedinBrowserProfileId: liveSession ? "prof_1" : null,
      linkedinSessionCheckedAt: liveSession ? "2026-09-11T20:00:00.000Z" : null,
      linkedinSessionInvalidAt: null,
      linkedinReadsPerDay: 80,
    }),
    saveConfig: () => {},
    logEvent: () => {},
    getLedger: () => ({
      getCachedEnrichment: (key: string) => (key.startsWith("person:") ? enrichmentCache : null),
      setCachedEnrichment: () => {},
      setCachedEnrichmentFailure: () => {},
      countCachedEnrichmentSince: () => 0,
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
      updateProspectIdentity: (id: number, patch: unknown) => {
        prospectWrites.push({ kind: "identity", id, patch });
        return true;
      },
    }),
    deepResearchPerson: async (input: { socialMediaUrl?: string; email?: string }) => {
      calls.research++;
      const name = input.socialMediaUrl ? providerNameByUrl : providerNameByEmail;
      return {
        result: {
          ...juliaResearch,
          status: researchStatus,
          result: {
            ...juliaResearch.result,
            ...(name ? { full_name: name } : {}),
            ...(providerLinkedIn ? { linkedin_url: providerLinkedIn } : {}),
          },
        },
        receiptId: 7,
      };
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
    browserTask: async () => {
      calls.browser++;
      return {
        result: {
          output: {
            loggedIn: true,
            name: liveName,
            headline: "Founder & Product Owner at WildMuse.App",
            experience: [
              {
                company: "WildMuse.App",
                title: "Founder & Product Owner",
                period: "Mar 2026 - Present",
              },
              {
                company: "L'ETO Group",
                title: "Head of Product and Business Development Manager",
                period: "Nov 2024 - Oct 2025",
              },
            ],
          },
          steps: [],
          cost: 0.012,
        },
        receiptId: 11,
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
    complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
      calls.classify++;
      lastClassifierInput = req.messages.find((m) => m.role === "user")?.content ?? "";
      return { content: verdict, provider: "t", model: "t" };
    },
  };
});

// Posts are captured on approval, never at row creation (newsfeed.test.ts
// covers that path); the mock records any call so a regression shows.
const newsfeedCalls: Array<{ id: number; remainingUsd?: number }> = [];
vi.mock("../src/_newsfeed.ts", () => ({
  NEWSFEED_COST_ESTIMATE_USD: 0.07,
  captureNewsfeedForQueueRow: async (
    id: number,
    _play: string,
    opts: { remainingUsd?: number },
  ) => {
    newsfeedCalls.push({
      id,
      ...(opts.remainingUsd !== undefined ? { remainingUsd: opts.remainingUsd } : {}),
    });
    return {
      outcome: {
        status: "captured",
        costUsd: 0.07,
        cached: false,
        feed: { url: "", fetchedAt: "", posts: [] },
      },
      attached: true,
    };
  },
}));

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
const { _resetLinkedInReadGate } = await import("../src/_linkedin-profile.ts");

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
  calls.research = calls.company = calls.classify = calls.webRead = calls.browser = 0;
  liveSession = false;
  delete process.env["LINKEDIN_SESSION_COOKIE"];
  _resetLinkedInReadGate();
  patches.length = notes.length = statuses.length = priorities.length = prospectWrites.length = 0;
  newsfeedCalls.length = 0;
  productCache.clear();
  enrichmentCache = null;
  liveRows = new Set([1, 2]);
  icp = "founders who own their own customer acquisition";
  verdict = '{"verdict":"pass","reason":"Founder of a consumer app, owns acquisition."}';
  researchStatus = "completed";
  providerNameByUrl = null;
  providerNameByEmail = null;
  liveName = "Julia Zabrodska-Akinci";
  pendingRows = [];
  providerLinkedIn = null;
});

const result = (linkedin_url: string) => ({
  status: "completed",
  result: { full_name: "Julia Zabrodska-Akinci", linkedin_url },
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

  it("seeds an X-sourced row from its twitterUrl (x-reposters, x-amplify-dm)", () => {
    expect(
      personSeedFor({ name: "Nick", handle: "Dayhaysoos", twitterUrl: "https://x.com/Dayhaysoos" })
        ?.url,
    ).toBe("https://x.com/Dayhaysoos");
    expect(
      personSeedFor({
        name: "Nick",
        twitterUrl: "https://x.com/Dayhaysoos",
        linkedinUrl: "https://www.linkedin.com/in/nick",
      })?.url,
    ).toBe("https://linkedin.com/in/nick");
    // a malformed value in one field does not hide the next
    expect(
      personSeedFor({ name: "Nick", twitterUrl: "not a url", githubUrl: "https://github.com/nick" })
        ?.url,
    ).toBe("https://github.com/nick");
  });
});

describe("namesAgree", () => {
  it("folds accents, accepts shared tokens and 4-letter prefixes, and never judges a company-named row", async () => {
    const { namesAgree } = await import("../src/_person-research.ts");
    expect(namesAgree("Matúš Pavliščák", "Matus Pavliscak")).toBe(true);
    expect(namesAgree("Mo Nasir", "Mohammed Nasir")).toBe(true);
    expect(namesAgree("Alex Meza", "Alexander Meza")).toBe(true);
    expect(namesAgree("Filip Kozera", "Rafael Lopez")).toBe(false);
    expect(namesAgree("Edvard Bakken", "Miriam Cameron")).toBe(false);
    expect(namesAgree("ability.ai", "Eugene Vyborov")).toBe(true);
    expect(namesAgree("Julia", "Rafael Lopez")).toBe(true);
    expect(namesAgree("Filip Kozera", null)).toBe(true);
  });
});

describe("researchPerson: the record must be about the person on the row", () => {
  it("retries by email when the profile URL's record names someone else, and uses that result", async () => {
    providerNameByUrl = "Rafael Lopez";
    providerNameByEmail = "Julia Zabrodska-Akinci";
    const { dossier, costUsd } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: Number.POSITIVE_INFINITY,
      liveProfile: false,
    });
    expect(calls.research).toBe(2);
    expect(dossier.status).toBe("complete");
    expect(dossier.currentRole?.company).toBe("WildMuse.App");
    expect(costUsd).toBeGreaterThan(0.05);
  });

  it("stops without a patch when the URL names someone else and there is no email to fall back on", async () => {
    providerNameByUrl = "Rafael Lopez";
    const { dossier } = await researchPerson({
      seed: personSeedFor({ ...juliaPayload, email: undefined }),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: Number.POSITIVE_INFINITY,
    });
    expect(calls.research).toBe(1);
    expect(calls.browser).toBe(0);
    expect(dossier.status).toBe("unavailable");
    expect(dossier.warning).toMatch(/different person \(Rafael Lopez\)/);
  });

  it("does not judge a business-named seed, and does not retry past the budget", async () => {
    const { seedNamesABusiness } = await import("../src/_person-research.ts");
    expect(
      seedNamesABusiness({ name: "Ridgeway Plumbing Ltd", company: "Ridgeway Plumbing, Ltd." }),
    ).toBe(true);
    expect(seedNamesABusiness({ name: "Julia Zabrodska", company: "L'eto Group" })).toBe(false);
    providerNameByUrl = "Rafael Lopez";
    const business = await researchPerson({
      seed: personSeedFor({
        name: "Ridgeway Plumbing Ltd",
        company: "Ridgeway Plumbing Ltd",
        linkedinUrl: "https://www.linkedin.com/in/rafaell0pez/",
      }),
      playName: "local-business",
      subject: { queueId: 1 },
      remainingUsd: Number.POSITIVE_INFINITY,
      liveProfile: false,
    });
    expect(calls.research).toBe(1);
    expect(business.dossier.status).toBe("complete");

    calls.research = 0;
    const capped = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 0.06,
      liveProfile: false,
    });
    expect(calls.research).toBe(1);
    expect(capped.dossier.status).toBe("unavailable");
    expect(capped.dossier.warning).toMatch(/different person/);
  });

  it("discards a live page that names someone else and keeps the provider's record", async () => {
    liveSession = true;
    liveName = "Rafael Lopez";
    const { dossier, liveSkipped } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: Number.POSITIVE_INFINITY,
    });
    expect(calls.browser).toBe(1);
    expect(liveSkipped).toBe("different-person");
    expect(dossier.liveProfile).toBeUndefined();
    expect(dossier.status).toBe("complete");
    expect(dossier.warning).toMatch(/different-person/);
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

describe("live LinkedIn tier", () => {
  const providerSaysLeto = {
    ...juliaResearch,
    result: {
      enrichment: {
        ...juliaResearch.result.enrichment,
        organizations: [
          {
            name: "L'ETO Group",
            title: "Head of Product and Business Development Manager",
            startDate: "Nov 2024",
            endDate_formatted: { is_current: true },
          },
          {
            name: "Old Co",
            title: "Analyst",
            startDate: "2018",
            endDate: "2020",
            endDate_formatted: { is_current: false },
          },
        ],
      },
    },
  };

  it("the live page wins on currency for the companies it lists; provider-only history is kept", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie";
    liveSession = true;
    enrichmentCache = {
      result_json: JSON.stringify(providerSaysLeto),
      fetched_at: new Date().toISOString(),
      status: "ok",
    };
    const { dossier, costUsd } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    expect(calls.browser).toBe(1);
    expect(dossier.currentRole).toEqual({
      title: "Founder & Product Owner",
      company: "WildMuse.App",
      since: "Mar 2026",
    });
    expect(dossier.organizations.map((o) => `${o.name}:${o.current}`)).toEqual([
      "WildMuse.App:true",
      "L'ETO Group:false",
      "Old Co:false",
    ]);
    expect(dossier.liveProfile?.url).toContain("linkedin.com/in/julia-zabrodska-akinci-cv");
    expect(costUsd).toBeCloseTo(0.012 + 0.005, 5);
    // The provider's bio stays; the page headline only fills a gap.
    expect(dossier.bio).toBe("Solo-built consumer wellness app from 0 to first revenue.");
  });

  it("does not read without a configured session, and records why", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie";
    liveSession = false; // cookie stored, never checked
    const { dossier } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    expect(calls.browser).toBe(0);
    expect(dossier.warning).toBe("live profile skipped: session-unchecked");
    expect(dossier.liveProfile).toBeUndefined();
  });

  it("liveProfile: false skips the read even with a session; a non-LinkedIn seed never reads", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie";
    liveSession = true;
    await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
      liveProfile: false,
    });
    await researchPerson({
      seed: personSeedFor({
        ...juliaPayload,
        linkedinUrl: undefined,
        sourceProfileUrl: "https://github.com/julia",
      }),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    expect(calls.browser).toBe(0);
  });

  it("a live read alone carries the row when the provider failed", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie";
    liveSession = true;
    researchStatus = "failed";
    const { dossier } = await researchPerson({
      seed: personSeedFor(juliaPayload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    expect(dossier.status).not.toBe("unavailable");
    expect(dossier.currentRole?.company).toBe("WildMuse.App");
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

  it("re-judges an affinity-mode row in affinity mode", async () => {
    const payload = { ...juliaPayload, icpAffinity: true };
    const { dossier } = await researchPerson({
      seed: personSeedFor(payload),
      playName: "luma-events",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    await rejudgePerson({
      playName: "luma-events",
      payload,
      patch: personPayloadPatch(payload, dossier),
      icp,
    });
    expect(JSON.parse(lastClassifierInput).person.affinity).toBe(true);
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
    expect(patches[0]?.patch).toEqual({
      personResearch: {
        ...dossier,
        warning: dossier.warning,
        liveProfile: null,
        currentRole: null,
        company: null,
        linkedinUrl: null,
      },
    });
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
    // research + company + live read; posts wait for approval.
    expect(result.costUsd).toBeCloseTo(0.4 + 0.055 + 0.01 + 0.05, 3);
  });

  it("never captures posts for the rows a finder just created", async () => {
    pendingRows = [row(1, "pending")];
    const result = { source: "find:luma-events", costUsd: 0, enqueued: 1, sdkCostUsd: 0 };
    await researchNewQueueRowPeople({
      afterId: 0,
      result: result as never,
      enabled: true,
      maxCostUsd: 10,
    });
    expect(patches.length).toBeGreaterThan(0);
    expect(newsfeedCalls).toEqual([]);
    expect(result.costUsd).toBeCloseTo(0.055 + 0.01 + 0.05, 3);
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

describe("researchMergePatch", () => {
  it("writes dropped optional keys as null so a merge patch removes them", async () => {
    const { researchMergePatch } = await import("../src/_person-research.ts");
    const patch = researchMergePatch({
      status: "complete",
      source: "deepResearchPerson",
      researchedAt: "2026-09-14T10:55:56.464Z",
      seed: { kind: "profile", url: "https://www.linkedin.com/in/x" },
      organizations: [],
      formerRoles: [],
      costUsd: 0,
    } as never);
    expect(patch).toMatchObject({
      warning: null,
      liveProfile: null,
      currentRole: null,
      company: null,
      linkedinUrl: null,
    });
    const live = researchMergePatch({
      status: "complete",
      liveProfile: { url: "https://www.linkedin.com/in/x", readAt: "2026-09-14T10:55:56.464Z" },
      warning: "x",
    } as never);
    expect(live["warning"]).toBe("x");
    expect(live["liveProfile"]).toMatchObject({ url: "https://www.linkedin.com/in/x" });
  });
});

describe("the provider's linkedin_url", () => {
  const githubSeed = {
    url: "https://github.com/jzabrodska",
    email: null,
    name: "Julia Zabrodska",
    company: null,
    title: null,
    domain: null,
  };

  it("is canonicalised to a /in/ profile and dropped when it is not one", async () => {
    const { providerLinkedInUrl } = await import("../src/_person-research.ts");
    expect(providerLinkedInUrl(result("http://linkedin.com/in/Julia-Z/?trk=x"), githubSeed)).toBe(
      "https://www.linkedin.com/in/julia-z",
    );
    expect(providerLinkedInUrl(result("www.linkedin.com/in/julia-z"), githubSeed)).toBe(
      "https://www.linkedin.com/in/julia-z",
    );
    expect(
      providerLinkedInUrl(
        {
          status: "completed",
          result: {
            enrichment: { full_name: "Julia Zabrodska", linkedin_url: "linkedin.com/in/jz" },
          },
        },
        githubSeed,
      ),
    ).toBe("https://www.linkedin.com/in/jz");
    expect(
      providerLinkedInUrl(result("https://www.linkedin.com/company/acme"), githubSeed),
    ).toBeNull();
    expect(providerLinkedInUrl(result(""), githubSeed)).toBeNull();
    expect(
      providerLinkedInUrl(
        { status: "failed", result: { linkedin_url: "linkedin.com/in/jz" } },
        githubSeed,
      ),
    ).toBeNull();
  });

  it("needs the first and last name to match: a shared surname or no record name is not enough", async () => {
    const { providerLinkedInUrl, namesIdentify } = await import("../src/_person-research.ts");
    expect(namesIdentify("Julia Smith", "Marcus Smith")).toBe(false);
    expect(namesIdentify("Julia Smith", "Julia Smith-Jones")).toBe(true);
    expect(namesIdentify("Matúš Kováč", "Matus Kovac")).toBe(true);
    expect(namesIdentify("Julia", "Julia Smith")).toBe(false);
    expect(namesIdentify(null, "Julia Smith")).toBe(false);
    const url = "https://linkedin.com/in/x";
    expect(
      providerLinkedInUrl(
        { status: "completed", result: { full_name: "Marcus Zabrodska", linkedin_url: url } },
        githubSeed,
      ),
    ).toBeNull();
    expect(
      providerLinkedInUrl({ status: "completed", result: { linkedin_url: url } }, githubSeed),
    ).toBeNull();
  });

  it("is dropped when the record names someone else, or the seed names a business", async () => {
    const { providerLinkedInUrl } = await import("../src/_person-research.ts");
    const other = {
      status: "completed",
      result: { full_name: "Marcus Brandt", linkedin_url: "https://linkedin.com/in/mbrandt" },
    };
    expect(providerLinkedInUrl(other, githubSeed)).toBeNull();
    const business = { ...githubSeed, name: "Acme Plumbing", company: "Acme Plumbing" };
    expect(
      providerLinkedInUrl(
        { status: "completed", result: { linkedin_url: "https://linkedin.com/in/owner" } },
        business,
      ),
    ).toBeNull();
  });

  it("a GitHub-seeded research lands it on the dossier", async () => {
    providerLinkedIn = "https://www.linkedin.com/in/julia-zabrodska-akinci-cv/";
    providerNameByUrl = "Julia Zabrodska-Akinci";
    const { dossier } = await researchPerson({
      seed: githubSeed,
      playName: "github-stars",
      subject: { queueId: 1 },
      remainingUsd: 1,
    });
    expect(dossier.linkedinUrl).toBe("https://www.linkedin.com/in/julia-zabrodska-akinci-cv");
  });

  it("fills an empty payload linkedinUrl and never replaces one the finder set", async () => {
    const dossier = {
      version: 1 as const,
      status: "partial" as const,
      researchedAt: "2026-09-27T00:00:00.000Z",
      seed: {},
      organizations: [],
      linkedinUrl: "https://www.linkedin.com/in/jz",
      costUsd: 0,
      cached: true,
    };
    expect(personPayloadPatch({ name: "Julia Zabrodska" }, dossier).linkedinUrl).toBe(
      "https://www.linkedin.com/in/jz",
    );
    expect(
      personPayloadPatch({ linkedinUrl: "https://www.linkedin.com/in/finder-pick" }, dossier)
        .linkedinUrl,
    ).toBeUndefined();
    expect(
      personPayloadPatch({}, { ...dossier, status: "unavailable" }).linkedinUrl,
    ).toBeUndefined();
  });

  it("fills a prospect's linkedin_url through the write-once identity update", async () => {
    providerLinkedIn = "https://linkedin.com/in/julia-zabrodska-akinci-cv";
    providerNameByUrl = "Julia Zabrodska-Akinci";
    const prospect = {
      id: 612,
      name: "Julia Zabrodska",
      company: "L'eto Group",
      email: "julia.zabrodska@letocaffe.com",
      source: "github-stars",
      source_profile_url: "https://github.com/jzabrodska",
      linkedin_url: null,
      dossier_json: null,
      title: null,
      icp_verdict: null,
    };
    const { dossier } = await researchPerson({
      seed: personSeedForProspect(prospect),
      playName: "research-prospects",
      subject: { prospectId: 612 },
      remainingUsd: 1,
    });
    const ledger = (await import("@oneshot-gtm/core")).getLedger();
    await applyPersonResearchToProspect(ledger, prospect, dossier, { rejudge: false, icp });
    expect(prospectWrites.find((w) => w["kind"] === "identity")).toEqual({
      kind: "identity",
      id: 612,
      patch: { linkedin_url: "https://www.linkedin.com/in/julia-zabrodska-akinci-cv" },
    });
  });

  it("dossierFromProviderResult carries it for a finder that already paid", async () => {
    const { dossierFromProviderResult } = await import("../src/_person-research.ts");
    const dossier = dossierFromProviderResult(
      { url: "https://x.com/jz", email: null, name: "Julia Zabrodska", company: null },
      {
        ...juliaResearch,
        result: {
          ...juliaResearch.result,
          full_name: "Julia Zabrodska",
          linkedin_url: "linkedin.com/in/jz",
        },
      },
      { costUsd: 0.05, billed: true },
    );
    expect(dossier?.linkedinUrl).toBe("https://www.linkedin.com/in/jz");
    expect(dossier?.currentRole?.company).toBe("WildMuse.App");
  });
});

describe("researchPerson cacheOnly", () => {
  const seed = {
    url: "https://www.linkedin.com/in/julia-zabrodska-akinci-cv",
    email: "julia.zabrodska@letocaffe.com",
    name: "Julia Zabrodska",
    company: "L'eto Group",
    title: null,
    domain: "letocaffe.com",
  };

  it("with nothing cached, buys nothing and says so", async () => {
    const out = await researchPerson({
      seed,
      playName: "research-queue",
      subject: { queueId: 1 },
      remainingUsd: 0,
      cacheOnly: true,
    });
    expect(out.notCached).toBe(true);
    expect(out.costUsd).toBe(0);
    expect(calls.research).toBe(0);
  });

  it("re-derives from the cache with no provider, live or company call, whatever the budget", async () => {
    liveSession = true;
    enrichmentCache = {
      result_json: JSON.stringify({
        ...juliaResearch,
        result: {
          ...juliaResearch.result,
          full_name: "Julia Zabrodska",
          linkedin_url: "linkedin.com/in/jz",
        },
      }),
      fetched_at: new Date().toISOString(),
      status: "ok",
    };
    const out = await researchPerson({
      seed,
      playName: "research-queue",
      subject: { queueId: 1 },
      remainingUsd: 0,
      cacheOnly: true,
    });
    expect(out.notCached).toBeUndefined();
    expect(out.costUsd).toBe(0);
    expect(out.dossier.currentRole?.company).toBe("WildMuse.App");
    expect(out.dossier.linkedinUrl).toBe("https://www.linkedin.com/in/jz");
    expect(calls).toMatchObject({ research: 0, company: 0, browser: 0 });
  });

  it("an expired or corrupt entry is a miss, never a paid call", async () => {
    enrichmentCache = {
      result_json: "{not json",
      fetched_at: new Date().toISOString(),
      status: "ok",
    };
    const corrupt = await researchPerson({
      seed,
      playName: "research-queue",
      subject: { queueId: 1 },
      remainingUsd: 10,
      cacheOnly: true,
    });
    expect(corrupt.notCached).toBe(true);
    expect(calls.research).toBe(0);
  });

  it("a cached record that names someone else is not retried by email with a paid call", async () => {
    enrichmentCache = {
      result_json: JSON.stringify({
        ...juliaResearch,
        result: { ...juliaResearch.result, full_name: "Marcus Brandt" },
      }),
      fetched_at: new Date().toISOString(),
      status: "ok",
    };
    const out = await researchPerson({
      seed,
      playName: "research-queue",
      subject: { queueId: 1 },
      remainingUsd: 10,
      cacheOnly: true,
    });
    expect(calls.research).toBe(0);
    expect(out.costUsd).toBe(0);
    expect(out.dossier.status).toBe("unavailable");
    expect(out.dossier.warning).toContain("different person");
  });

  it("a negative cache entry is not research", async () => {
    enrichmentCache = { result_json: "{}", fetched_at: new Date().toISOString(), status: "failed" };
    const out = await researchPerson({
      seed,
      playName: "research-queue",
      subject: { queueId: 1 },
      remainingUsd: 0,
      cacheOnly: true,
    });
    expect(out.notCached).toBe(true);
  });
});

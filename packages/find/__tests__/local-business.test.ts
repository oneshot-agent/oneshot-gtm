import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// local-business is the only finder built on `peopleSearch`/`companySearch`
// instead of the per-candidate resolve spine. The crux under test: a
// `best_work_email` on the search result routes to the cheap lane (skip
// findEmail/verifyEmail, straight to the person gate) while its absence
// falls back to the normal `resolveVerifyEnrichQualify` spine, and business-
// shaped targeting (industries set, no jobTitles) runs `companySearch` first
// and feeds its domains into `peopleSearch`. Mock the module boundaries the
// finder calls (SDK-safe wrappers, ICP/person filter, enrich, dedupe, ledger).

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}
const enqueued: EnqueuedRow[] = [];
let icpMatch: boolean | null = true;
let personVerdict: "pass" | "reject" | "unclear" | "transient" = "pass";

interface StubPerson {
  full_name?: string;
  first_name?: string;
  last_name?: string | null;
  title?: string;
  company?: string;
  company_domain?: string;
  linkedin_url?: string;
  best_work_email?: string;
  phone?: string;
  email?: string;
}
interface StubCompany {
  name?: string;
  domain?: string;
  industry?: string;
}

interface StubLocal {
  id?: string;
  name?: string;
  domain?: string | null;
  website?: string | null;
  phone?: string | null;
  category?: string | null;
  address?: string | null;
}

let nextPeopleSearchResults: StubPerson[] = [];
/** Set to answer each people search by its input (paging, per-title searches). */
let peopleSearchHandler: ((input: Record<string, unknown>) => StubPerson[]) | null = null;
/** Dedupe keys the queue already holds. */
const knownKeys = new Set<string>();
/** The ledger's small key-value cache. */
const researchCache = new Map<string, string>();
let icpCalls = 0;
let nextCompanySearchResults: StubCompany[] = [];
let nextLocalSearchResults: StubLocal[] = [];
let localSearchStatus: "ok" | "error" = "ok";
const peopleSearchCalls: Array<Record<string, unknown>> = [];
const companySearchCalls: Array<Record<string, unknown>> = [];
const localSearchCalls: Array<Record<string, unknown>> = [];
const findEmailCalls: string[] = [];
const verifyEmailCalls: string[] = [];

vi.mock("../src/_sdk-safe.ts", () => ({
  safePeopleSearch: async (input: Record<string, unknown>) => {
    peopleSearchCalls.push(input);
    const results = peopleSearchHandler ? peopleSearchHandler(input) : nextPeopleSearchResults;
    return {
      result: { status: "ok", results, total_found: results.length, cost: 0.01 },
      receiptId: 1,
    };
  },
  safeCompanySearch: async (input: Record<string, unknown>) => {
    companySearchCalls.push(input);
    return {
      result: {
        status: "ok",
        results: nextCompanySearchResults,
        total_found: nextCompanySearchResults.length,
        cost: 0.01,
      },
      receiptId: 1,
    };
  },
  safeLocalSearch: async (input: Record<string, unknown>) => {
    localSearchCalls.push(input);
    return {
      result: {
        status: localSearchStatus,
        results: localSearchStatus === "ok" ? nextLocalSearchResults : [],
        total_found: nextLocalSearchResults.length,
        truncated: false,
        vendor_calls: 1,
        cost: localSearchStatus === "ok" ? 0.02 : 0,
      },
      receiptId: 9,
    };
  },
  safeFindEmail: async (input: { companyDomain?: string | null }) => {
    findEmailCalls.push(input.companyDomain ?? "");
    return { result: { found: true, email: "resolved@acme.dev", cost: 0.005 }, receiptId: 2 };
  },
  safeVerifyEmail: async (input: { email: string }) => {
    verifyEmailCalls.push(input.email);
    return { result: { deliverable: true, cost: 0.006 }, receiptId: 3 };
  },
}));

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => {
    icpCalls++;
    return {
      match: icpMatch,
      reason: icpMatch === null ? "icp classifier unavailable" : icpMatch ? "fits" : "nope",
    };
  },
  hasRoleText: (p: { roleText?: string | null }) => (p.roleText ?? "").trim().length > 0,
  qualifyPerson: async () => ({ verdict: personVerdict, reason: "stub" }),
}));

vi.mock("../src/_enrich.ts", () => ({
  enrichVerifiedContact: async () => ({
    phone: null,
    linkedinUrl: null,
    title: null,
    summary: null,
    costUsd: 0.005,
    receiptId: 4,
  }),
}));

vi.mock("../src/_dedupe.ts", () => ({ isDuplicate: () => false }));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({
      isQueueDuplicate: (_play: string, dedupeKey: string) => knownKeys.has(dedupeKey),
      getProductResearchCache: (key: string) => researchCache.get(key) ?? null,
      setProductResearchCache: (key: string, value: string) => {
        researchCache.set(key, value);
      },
      isLinkedInProfileKnown: () => false,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runLocalBusinessFinder, isContactable, parseSearchProgress, peopleQueries } =
  await import("../src/local-business.ts");
const { withFinderChannels } = await import("../src/_channels-context.ts");

const basePerson: StubPerson = {
  full_name: "Dana Rivera",
  title: "Owner",
  company: "Rivera HVAC",
  company_domain: "riverahvac.com",
  linkedin_url: "https://www.linkedin.com/in/dana-rivera",
};

beforeEach(() => {
  enqueued.length = 0;
  icpMatch = true;
  personVerdict = "pass";
  nextPeopleSearchResults = [];
  peopleSearchHandler = null;
  knownKeys.clear();
  researchCache.clear();
  icpCalls = 0;
  nextCompanySearchResults = [];
  nextLocalSearchResults = [];
  localSearchStatus = "ok";
  peopleSearchCalls.length = 0;
  companySearchCalls.length = 0;
  localSearchCalls.length = 0;
  findEmailCalls.length = 0;
  verifyEmailCalls.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runLocalBusinessFinder — lane routing on best_work_email", () => {
  it("skips findEmail/verifyEmail entirely when best_work_email is present (lane 1)", async () => {
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "free scheduling setup",
    });

    expect(findEmailCalls).toHaveLength(0);
    expect(verifyEmailCalls).toHaveLength(0);
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("free-pilot");
    expect(row.payload["email"]).toBe("dana@riverahvac.com");
    expect(row.payload["businessType"]).toBeTruthy();
    expect(typeof row.payload["fitReason"]).toBe("string"); // #592
    expect(row.payload["fitReasonSource"]).toBe("company-gate");
  });

  it("costs approximately one search call, not one call per candidate, when every result has best_work_email", async () => {
    // The whole point of the finder: N candidates, all with best_work_email,
    // must not multiply the per-candidate findEmail+verifyEmail spend.
    nextPeopleSearchResults = Array.from({ length: 5 }, (_, i) => ({
      full_name: `Owner ${i}`,
      title: "Owner",
      company: `Business ${i}`,
      company_domain: `biz${i}.com`,
      best_work_email: `owner${i}@biz${i}.com`,
    }));
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "free setup",
    });

    expect(out.enqueued).toBe(5);
    expect(findEmailCalls).toHaveLength(0);
    expect(verifyEmailCalls).toHaveLength(0);
    // One $0.01 peopleSearch call total, no per-candidate resolve spend:
    // against ~5 * $0.011 = $0.055 the old per-candidate spine would cost.
    expect(out.costUsd).toBeCloseTo(0.01, 5);
    expect(peopleSearchCalls).toHaveLength(1);
  });

  it("falls back to resolveVerifyEnrichQualify when best_work_email is absent (lane 2)", async () => {
    nextPeopleSearchResults = [{ ...basePerson }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "free setup",
    });

    expect(findEmailCalls).toEqual(["riverahvac.com"]);
    expect(verifyEmailCalls).toEqual(["resolved@acme.dev"]);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["email"]).toBe("resolved@acme.dev");
    // search cost + findEmail + verify + enrich, all real per-candidate spend.
    expect(out.costUsd).toBeCloseTo(0.01 + 0.005 + 0.006 + 0.005, 5);
  });
});

describe("runLocalBusinessFinder — people search size", () => {
  it("asks for a page the platform can finish before its 120s job timeout, not the 500 cap", async () => {
    nextPeopleSearchResults = [];
    await runLocalBusinessFinder({ dryRun: true, jobTitles: ["Head of AI"], yourEdge: "x" });
    expect(peopleSearchCalls).toHaveLength(1);
    const limit = peopleSearchCalls[0]?.["limit"] as number;
    // ~2.2s per row measured 2026-09-27: 50 rows took 107s, 100 timed out.
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(40);
  });
});

/** `n` complete people starting at index `from`, each with a work email (the cheap lane). */
function people(from: number, n: number): StubPerson[] {
  return Array.from({ length: n }, (_, i) => ({
    full_name: `Person ${from + i}`,
    title: "Head of AI",
    company: `Company ${from + i}`,
    company_domain: `company${from + i}.com`,
    linkedin_url: `https://www.linkedin.com/in/person-${from + i}`,
    best_work_email: `p${from + i}@company${from + i}.com`,
  }));
}
const keyOf = (i: number) => `free-pilot:li:https://www.linkedin.com/in/person-${i}`;
/** A row the people database returns with a first name and nothing else. */
const nameOnly = (first: string): StubPerson => ({
  full_name: first,
  first_name: first,
  last_name: null,
  title: "Chief AI Officer",
  company: "A Bank",
});

describe("runLocalBusinessFinder — paging past people it already has", () => {
  it("people already in the queue do not use up the limit", async () => {
    // The first 30 of the page are known. Counting them against the limit is
    // what stalled the finder on its first page every day.
    nextPeopleSearchResults = people(0, 35);
    for (let i = 0; i < 30; i++) knownKeys.add(keyOf(i));
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI"],
      limit: 5,
      yourEdge: "x",
    });
    expect(out.droppedDuplicate).toBe(30);
    expect(out.enqueued).toBe(5);
  });

  it("asks for the next page by offset when a full page leaves room under the limit", async () => {
    peopleSearchHandler = (input) => {
      const offset = (input["offset"] as number | undefined) ?? 0;
      return offset === 0 ? people(0, 40) : offset === 40 ? people(40, 12) : [];
    };
    for (let i = 0; i < 40; i++) knownKeys.add(keyOf(i));
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI"],
      limit: 25,
      yourEdge: "x",
    });
    // Page 2 is short, so it is the last: no third call.
    expect(peopleSearchCalls.map((c) => c["offset"] ?? 0)).toEqual([0, 40]);
    expect(out.candidates).toBe(52);
    expect(out.enqueued).toBe(12);
    expect(out.costUsd).toBeCloseTo(0.02, 5);
  });

  it("stops asking once the limit is reached", async () => {
    peopleSearchHandler = (input) => people((input["offset"] as number | undefined) ?? 0, 40);
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI"],
      limit: 3,
      yourEdge: "x",
    });
    expect(peopleSearchCalls).toHaveLength(1);
    expect(out.enqueued).toBe(3);
  });

  it("stops when the server ignores the offset and returns the same page again", async () => {
    nextPeopleSearchResults = people(0, 40);
    for (let i = 0; i < 40; i++) knownKeys.add(keyOf(i));
    await runLocalBusinessFinder({ dryRun: false, jobTitles: ["Head of AI"], yourEdge: "x" });
    expect(peopleSearchCalls).toHaveLength(2);
  });

  it("stops at the page cap, and the next run carries on from there", async () => {
    // 300 people, the first 280 known: six pages a run never reaches the new
    // ones unless the second run starts where the first stopped.
    peopleSearchHandler = (input) => {
      const offset = (input["offset"] as number | undefined) ?? 0;
      return people(offset, Math.max(0, Math.min(40, 300 - offset)));
    };
    for (let i = 0; i < 280; i++) knownKeys.add(keyOf(i));
    const run = () =>
      runLocalBusinessFinder({ dryRun: false, jobTitles: ["Head of AI"], yourEdge: "x" });

    const first = await run();
    expect(peopleSearchCalls.map((c) => c["offset"] ?? 0)).toEqual([0, 40, 80, 120, 160, 200]);
    expect(first.enqueued).toBe(0);

    peopleSearchCalls.length = 0;
    const second = await run();
    expect(peopleSearchCalls.map((c) => c["offset"] ?? 0)).toEqual([240, 280]);
    expect(second.enqueued).toBe(20);
  });

  it("reads stored progress, and starts from the top on anything unreadable", () => {
    expect(parseSearchProgress(JSON.stringify({ done: true }))).toEqual({ done: true });
    expect(parseSearchProgress(JSON.stringify({ done: false, offset: 240 }))).toEqual({
      done: false,
      offset: 240,
    });
    expect(parseSearchProgress(null)).toBeNull();
    expect(parseSearchProgress("2026-10-10T00:00:00.000Z")).toBeNull();
    expect(parseSearchProgress(JSON.stringify({ offset: -40 }))).toBeNull();
    expect(parseSearchProgress(JSON.stringify({ offset: "240" }))).toBeNull();
  });

  it("a search resumed past its last person is then left alone", async () => {
    peopleSearchHandler = (input) => {
      const offset = (input["offset"] as number | undefined) ?? 0;
      return people(offset, Math.max(0, Math.min(40, 240 - offset)));
    };
    for (let i = 0; i < 240; i++) knownKeys.add(keyOf(i));
    const run = () =>
      runLocalBusinessFinder({ dryRun: false, jobTitles: ["Head of AI"], yourEdge: "x" });
    await run(); // six full pages, stopped at the cap
    peopleSearchCalls.length = 0;
    const second = await run(); // resumes at 240: empty, so the search is finished
    expect(peopleSearchCalls.map((c) => c["offset"])).toEqual([240]);
    // Not "no matches, widen your targeting": the search has people, all known.
    expect(second.halted).toMatch(/walked to its end/);
    peopleSearchCalls.length = 0;
    const third = await run();
    expect(peopleSearchCalls).toHaveLength(0);
    expect(third.halted).toMatch(/walked to its end/);
  });
});

describe("runLocalBusinessFinder — name-only rows", () => {
  it("tells a complete row from a name-only one", () => {
    expect(isContactable({ full_name: "Dana Rivera", company_domain: "riverahvac.com" })).toBe(
      true,
    );
    expect(
      isContactable({ first_name: "Dana", last_name: "Rivera", linkedin_url: "https://x/in/d" }),
    ).toBe(true);
    // A first name is not a person to look up.
    expect(
      isContactable({ full_name: "David", first_name: "David", last_name: null } as never),
    ).toBe(false);
    expect(isContactable({ full_name: "David", company_domain: "hsbc.com" })).toBe(false);
    // A full name with nothing that places the person.
    expect(isContactable({ full_name: "Dana Rivera" })).toBe(false);
    expect(isContactable({})).toBe(false);
  });

  it("skips them before the ICP call and any paid step, and says why nothing was queued", async () => {
    nextPeopleSearchResults = [nameOnly("David"), nameOnly("Pedro"), nameOnly("Sachin")];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Chief AI Officer"],
      yourEdge: "x",
    });
    expect(icpCalls).toBe(0);
    expect(findEmailCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    expect(out.droppedEnrichment).toBe(3);
    expect(out.halted).toMatch(/3 of 3 search results had no last name/);
    // A page with no one to contact ends the search: one call, not six.
    expect(peopleSearchCalls).toHaveLength(1);
  });

  it("works the complete rows of a mixed page", async () => {
    nextPeopleSearchResults = [nameOnly("David"), ...people(0, 2), nameOnly("Pedro")];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI"],
      yourEdge: "x",
    });
    expect(out.enqueued).toBe(2);
    expect(out.droppedEnrichment).toBe(2);
    expect(icpCalls).toBe(2);
    expect(out.halted).toBeUndefined();
  });
});

describe("runLocalBusinessFinder — several titles", () => {
  it("runs the combined search, then one per title", () => {
    const shared = { keywords: ["agents"] };
    expect(
      peopleQueries({
        businessShaped: false,
        companyDomains: [],
        jobTitles: ["Head of AI", "VP of AI"],
        industries: [],
        shared,
      }),
    ).toEqual([
      { jobTitles: ["Head of AI", "VP of AI"], keywords: ["agents"] },
      { jobTitles: ["Head of AI"], keywords: ["agents"] },
      { jobTitles: ["VP of AI"], keywords: ["agents"] },
    ]);
    // One title, or business-shaped targeting: one search, as before.
    expect(
      peopleQueries({
        businessShaped: false,
        companyDomains: [],
        jobTitles: ["Owner"],
        industries: ["HVAC"],
        shared: {},
      }),
    ).toEqual([{ jobTitles: ["Owner"], industry: ["HVAC"] }]);
    expect(
      peopleQueries({
        businessShaped: true,
        companyDomains: ["a.com"],
        jobTitles: [],
        industries: ["Dental"],
        shared: { location: ["Austin"] },
      }),
    ).toEqual([{ companyDomains: ["a.com"], location: ["Austin"] }]);
  });

  it("reaches people only a single-title search returns, and works each person once", async () => {
    peopleSearchHandler = (input) => {
      const titles = input["jobTitles"] as string[];
      if (titles.length === 2) return people(0, 3);
      // The per-title search repeats one person and adds one.
      return titles[0] === "Head of AI" ? [...people(2, 1), ...people(10, 1)] : [];
    };
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI", "VP of AI"],
      yourEdge: "x",
    });
    expect(peopleSearchCalls.map((c) => c["jobTitles"])).toEqual([
      ["Head of AI", "VP of AI"],
      ["Head of AI"],
      ["VP of AI"],
    ]);
    expect(out.enqueued).toBe(4);
    expect(icpCalls).toBe(4);
  });

  it("does not start another search once the limit is reached", async () => {
    nextPeopleSearchResults = people(0, 3);
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI", "VP of AI"],
      limit: 3,
      yourEdge: "x",
    });
    expect(out.enqueued).toBe(3);
    expect(peopleSearchCalls).toHaveLength(1);
  });

  it("does not park a search it stopped reading part-way through", async () => {
    // One known person, then the limit is reached on the next: the rest of
    // the page was never looked at.
    nextPeopleSearchResults = people(0, 5);
    knownKeys.add(keyOf(0));
    await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI"],
      limit: 1,
      yourEdge: "x",
    });
    expect(researchCache.size).toBe(0);
  });

  it("makes at most twelve searches in one run", async () => {
    const titles = Array.from({ length: 20 }, (_, i) => `Title ${i}`);
    peopleSearchHandler = () => [];
    await runLocalBusinessFinder({ dryRun: false, jobTitles: titles, yourEdge: "x" });
    expect(peopleSearchCalls).toHaveLength(12);
  });
});

describe("runLocalBusinessFinder — a search with no one new", () => {
  it("is left alone on the next run instead of being paid for again", async () => {
    nextPeopleSearchResults = people(0, 10);
    for (let i = 0; i < 10; i++) knownKeys.add(keyOf(i));
    const first = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI"],
      yourEdge: "x",
    });
    expect(peopleSearchCalls).toHaveLength(1);
    expect(first.droppedDuplicate).toBe(10);

    const second = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Head of AI"],
      yourEdge: "x",
    });
    expect(peopleSearchCalls).toHaveLength(1);
    expect(second.costUsd).toBe(0);
    expect(second.halted).toMatch(/walked to its end/);
  });

  it("is searched again while it still returns someone new", async () => {
    nextPeopleSearchResults = people(0, 10);
    await runLocalBusinessFinder({ dryRun: false, jobTitles: ["Head of AI"], yourEdge: "x" });
    await runLocalBusinessFinder({ dryRun: false, jobTitles: ["Head of AI"], yourEdge: "x" });
    expect(peopleSearchCalls).toHaveLength(2);
  });

  it("a dry run never marks a search as walked", async () => {
    nextPeopleSearchResults = people(0, 10);
    for (let i = 0; i < 10; i++) knownKeys.add(keyOf(i));
    await runLocalBusinessFinder({ dryRun: true, jobTitles: ["Head of AI"], yourEdge: "x" });
    expect(researchCache.size).toBe(0);
  });

  it("an empty search says to widen the targeting, and is tried again the next run", async () => {
    // Zero rows is also what a platform outage returns: never park it.
    nextPeopleSearchResults = [];
    const run = () =>
      runLocalBusinessFinder({ dryRun: false, jobTitles: ["Head of AI"], yourEdge: "x" });
    expect((await run()).halted).toMatch(/returned no matches/);
    expect((await run()).halted).toMatch(/returned no matches/);
    expect(peopleSearchCalls).toHaveLength(2);
    expect(researchCache.size).toBe(0);
  });

  it("a search that returned only name-only rows is tried again the next run", async () => {
    nextPeopleSearchResults = [nameOnly("David"), nameOnly("Pedro")];
    const run = () =>
      runLocalBusinessFinder({ dryRun: false, jobTitles: ["Chief AI Officer"], yourEdge: "x" });
    await run();
    await run();
    expect(peopleSearchCalls).toHaveLength(2);
  });
});

describe("runLocalBusinessFinder — channel order", () => {
  it("a LinkedIn-first run queues on LinkedIn even when the search carries an email", async () => {
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    const out = await withFinderChannels(["linkedin", "email"], () =>
      runLocalBusinessFinder({ dryRun: false, jobTitles: ["Owner"], yourEdge: "free setup" }),
    );
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]).toMatchObject({ channel: "linkedin" });
    expect(enqueued[0]?.payload["linkedinUrl"]).toBe(basePerson.linkedin_url);
    expect(findEmailCalls).toHaveLength(0);
  });
});

describe("runLocalBusinessFinder — business-shaped targeting", () => {
  it("runs companySearch first and feeds company_domains into peopleSearch when industries is set and jobTitles is empty", async () => {
    nextCompanySearchResults = [
      { name: "Smile Dental", domain: "smiledental.com", industry: "Dental Practices" },
      { name: "Bright Teeth", domain: "brightteeth.com", industry: "Dental Practices" },
    ];
    nextPeopleSearchResults = [
      {
        full_name: "Pat Lee",
        title: "Practice Manager",
        company: "Smile Dental",
        company_domain: "smiledental.com",
        best_work_email: "pat@smiledental.com",
      },
    ];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      industries: ["Dental Practices"],
      yourEdge: "free intake form setup",
    });

    expect(companySearchCalls).toHaveLength(1);
    expect(companySearchCalls[0]?.["industry"]).toEqual(["Dental Practices"]);
    expect(peopleSearchCalls).toHaveLength(1);
    expect(peopleSearchCalls[0]?.["companyDomains"]).toEqual([
      "smiledental.com",
      "brightteeth.com",
    ]);
    // Pass resolved domains to peopleSearch instead of industry targeting.
    expect(peopleSearchCalls[0]?.["industry"]).toBeUndefined();
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]?.payload["businessType"]).toBe("Dental Practices");
  });

  it("halts without calling peopleSearch when companySearch returns no companies", async () => {
    nextCompanySearchResults = [];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      industries: ["Dental Practices"],
      yourEdge: "x",
    });
    expect(peopleSearchCalls).toHaveLength(0);
    expect(out.enqueued).toBe(0);
    expect(out.halted).toBeTruthy();
  });

  it("halts before peopleSearch when companySearch alone already hit maxCostUsd (finding PRRT_kwDOSKzrBs6ewrQT)", async () => {
    nextCompanySearchResults = [
      { name: "Smile Dental", domain: "smiledental.com", industry: "Dental Practices" },
    ];
    nextPeopleSearchResults = [
      { ...basePerson, company_domain: "smiledental.com", best_work_email: "dana@smiledental.com" },
    ];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      industries: ["Dental Practices"],
      maxCostUsd: 0.01,
      yourEdge: "x",
    });
    // companySearch alone costs $0.01 and hits the cap: peopleSearch must
    // never run, so the second $0.01 charge never accrues.
    expect(companySearchCalls).toHaveLength(1);
    expect(peopleSearchCalls).toHaveLength(0);
    expect(out.enqueued).toBe(0);
    expect(out.costUsd).toBeCloseTo(0.01, 5);
    expect(out.halted).toMatch(/max-cost cap/);
  });
});

describe("runLocalBusinessFinder — ICP gate and limits", () => {
  it("persists a rejected row instead of a target when the ICP filter misses", async () => {
    icpMatch = false;
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "x",
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.initialStatus).toBe("rejected");
    expect(enqueued[0]?.playName).toBe("free-pilot");
  });

  it("does NOT persist a rejected row when the classifier is transiently unavailable (match=null)", async () => {
    icpMatch = null;
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "x",
    });
    expect(enqueued).toHaveLength(0);
  });

  it("respects the enqueue limit", async () => {
    nextPeopleSearchResults = Array.from({ length: 5 }, (_, i) => ({
      full_name: `Owner ${i}`,
      title: "Owner",
      company: `Business ${i}`,
      company_domain: `biz${i}.com`,
      best_work_email: `owner${i}@biz${i}.com`,
    }));
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      limit: 2,
      yourEdge: "x",
    });
    expect(out.enqueued).toBe(2);
  });

  it("persists a rejected row instead of a target when the person-level role gate rejects", async () => {
    personVerdict = "reject";
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      jobTitles: ["Owner"],
      yourEdge: "x",
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedRole).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.initialStatus).toBe("rejected");
  });
});

describe("runLocalBusinessFinder — `local` engine (SDK localSearch)", () => {
  const baseBiz: StubLocal = {
    id: "loc_abc",
    name: "Rivera Family Dental",
    domain: "riverafamilydental.com",
    website: "https://riverafamilydental.com",
    phone: "+1 512 555 0142",
    category: "dental practice",
    address: "100 Congress Ave, Austin, TX",
  };

  it("never calls localSearch when engine is absent — the B2B path is unchanged by default", async () => {
    nextPeopleSearchResults = [{ ...basePerson, best_work_email: "dana@riverahvac.com" }];
    await runLocalBusinessFinder({ dryRun: false, jobTitles: ["Owner"], yourEdge: "x" });
    expect(localSearchCalls).toHaveLength(0);
    expect(peopleSearchCalls).toHaveLength(1);
  });

  it("searches category × location with contactable, non-chain, open businesses; peopleSearch is only ever the domain-scoped person lookup, never discovery", async () => {
    nextLocalSearchResults = [baseBiz];
    nextPeopleSearchResults = [{ full_name: "Dana Rivera", title: "Owner" }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "we set up online booking free",
    });
    expect(localSearchCalls).toHaveLength(1);
    expect(localSearchCalls[0]).toMatchObject({
      category: ["dental practice"],
      location: ["Austin, TX"],
      hasDomain: true,
      isChain: false,
      operatingStatus: "open",
    });
    // Every peopleSearch the local engine causes is the spine's lookup of a
    // person at one business's domain. Never a jobTitles/industry search.
    for (const call of peopleSearchCalls) {
      expect(call).toMatchObject({ companyDomains: ["riverafamilydental.com"] });
      expect(call).not.toHaveProperty("jobTitles");
      expect(call).not.toHaveProperty("industry");
    }
    expect(companySearchCalls).toHaveLength(0);
    expect(out.enqueued).toBe(1);
  });

  it("walks a business through the domain-only spine and enqueues the free-pilot businessType shape", async () => {
    nextLocalSearchResults = [baseBiz];
    // SDK 0.32 findEmail needs a person: the spine looks one up at the domain.
    nextPeopleSearchResults = [{ full_name: "Dana Rivera", title: "Owner" }];
    await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "we set up online booking free",
    });
    // No owner name on a places result: the spine found one at the domain,
    // then findEmail ran against it.
    expect(peopleSearchCalls[0]).toMatchObject({ companyDomains: ["riverafamilydental.com"] });
    expect(findEmailCalls).toEqual(["riverafamilydental.com"]);
    const row = enqueued[0]!;
    expect(row.playName).toBe("free-pilot");
    expect(row.dedupeKey).toBe("free-pilot:local:loc_abc");
    expect(row.payload).toMatchObject({
      company: "Rivera Family Dental",
      businessType: "dental practice",
      email: "resolved@acme.dev",
      address: "100 Congress Ave, Austin, TX",
      city: "Austin, TX",
      yourEdge: "we set up online booking free",
    });
  });

  it("halts with a named reason when industries or locations are missing, before any search", async () => {
    const out = await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      yourEdge: "x",
    });
    expect(out.halted).toMatch(/locations/);
    expect(localSearchCalls).toHaveLength(0);
  });

  it("halts on a platform error rather than reporting no businesses", async () => {
    localSearchStatus = "error";
    const out = await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "x",
    });
    expect(out.halted).toMatch(/platform error/);
    expect(out.enqueued).toBe(0);
  });

  it("drops a result with no domain and counts the search's cost", async () => {
    nextLocalSearchResults = [{ ...baseBiz, id: "nodomain", domain: null }];
    const out = await runLocalBusinessFinder({
      dryRun: false,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "x",
    });
    expect(out.droppedEnrichment).toBe(1);
    expect(out.enqueued).toBe(0);
    expect(out.costUsd).toBe(0.02);
  });

  it("dry-run counts without enqueuing or resolving contacts", async () => {
    nextLocalSearchResults = [baseBiz, { ...baseBiz, id: "loc_2", name: "Second Dental" }];
    const out = await runLocalBusinessFinder({
      dryRun: true,
      engine: "local",
      industries: ["dental practice"],
      locations: ["Austin, TX"],
      yourEdge: "x",
    });
    expect(out.enqueued).toBe(2);
    expect(enqueued).toHaveLength(0);
    expect(findEmailCalls).toHaveLength(0);
  });
});

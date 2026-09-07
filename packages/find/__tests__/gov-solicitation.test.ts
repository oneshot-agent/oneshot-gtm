import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for runGovSolicitationFinder on SDK 0.32's
// `govSolicitations`: ONE flat-priced search per run returns every notice
// with its contracting officer's contact and the description inline. The
// SDK boundary is mocked at `_sdk-safe.ts` (the way local-business mocks
// `safePeopleSearch`), so what is under test is the mapping, routing,
// dedupe and halt behaviour around that one call — there is no per-notice
// fetch, no SAM.gov key, and no description retry left to exercise.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}

const enqueued: EnqueuedRow[] = [];
const searchCalls: Array<Record<string, unknown>> = [];
let nextResults: unknown[] = [];
let searchStatus: "ok" | "error" = "ok";
let searchCost = 0.02;
let findProspectByEmailResult: { id: number } | null = null;
let emailPendingInQueue = false;
let queueDuplicate = false;

vi.mock("../src/_sdk-safe.ts", () => ({
  safeGovSolicitations: async (input: Record<string, unknown>) => {
    searchCalls.push(input);
    return {
      result: {
        status: searchStatus,
        results: searchStatus === "ok" ? nextResults : [],
        total_found: nextResults.length,
        truncated: false,
        description_fetches: 0,
        vendor_calls: 1,
        cost: searchStatus === "ok" ? searchCost : 0,
      },
      receiptId: searchStatus === "ok" ? 7 : 0,
    };
  },
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({
      isQueueDuplicate: () => queueDuplicate,
      findProspectByEmail: () => findProspectByEmailResult,
      isEmailPendingInQueue: () => emailPendingInQueue,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runGovSolicitationFinder } = await import("../src/gov-solicitation.ts");

function notice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notice_id: "abc123",
    id: "abc123",
    notice_type: "sources_sought",
    notice_type_code: "r",
    title: "AI-assisted document review pilot",
    solicitation_number: "47PF0018R0023",
    agency: "GENERAL SERVICES ADMINISTRATION",
    naics_code: "541511",
    posted_date: "2026-08-01",
    response_deadline: "2026-12-01",
    active: true,
    set_aside: null,
    place_of_performance: null,
    contact: {
      name: "Jesse L. Jones",
      email: "jesse.jones@gsa.gov",
      phone: "2174941263",
      title: "Contracting Officer",
      type: "primary",
    },
    contacts: [],
    description: "<p>Full RFP body text.</p>",
    description_truncated: false,
    url: "https://sam.gov/opp/abc123/view",
    ...overrides,
  };
}

beforeEach(() => {
  enqueued.length = 0;
  searchCalls.length = 0;
  nextResults = [notice()];
  searchStatus = "ok";
  searchCost = 0.02;
  findProspectByEmailResult = null;
  emailPendingInQueue = false;
  queueDuplicate = false;
});

afterEach(() => vi.clearAllMocks());

const baseConfig = {
  dryRun: false,
  naics: ["541511"],
  noticeTypes: ["r", "p"],
  yourEdge: "we cut review time in half",
  sinceDays: 30,
  limit: 25,
};

describe("runGovSolicitationFinder — happy path", () => {
  it("enqueues a notice carrying the notice number, type, published contact and stripped description, and counts the search's cost", async () => {
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(out.costUsd).toBe(0.02);
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("sources-sought");
    expect(row.payload["noticeNumber"]).toBe("47PF0018R0023");
    expect(row.payload["noticeType"]).toBe("Sources Sought");
    expect(row.payload["email"]).toBe("jesse.jones@gsa.gov");
    expect(row.payload["name"]).toBe("Jesse L. Jones");
    expect(row.payload["role"]).toBe("Contracting Officer");
    expect(row.payload["phone"]).toBe("2174941263");
    expect(row.payload["noticeUrl"]).toBe("https://sam.gov/opp/abc123/view");
    expect(row.payload["descriptionSnippet"]).toBe("Full RFP body text.");
    expect(row.payload["yourEdge"]).toBe("we cut review time in half");
  });

  it("makes exactly one search for all NAICS codes, asking for contacts, active notices and descriptions inline", async () => {
    await runGovSolicitationFinder({
      ...baseConfig,
      naics: ["541511", "541512"],
      agencies: ["gsa"],
    });
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]).toMatchObject({
      naics: ["541511", "541512"],
      noticeTypes: ["r", "p"],
      sinceDays: 30,
      agencies: ["gsa"],
      hasContact: true,
      activeOnly: true,
      includeDescription: true,
    });
  });

  it("dedupes a notice id the SDK returns twice", async () => {
    nextResults = [
      notice({ notice_id: "shared" }),
      notice({ notice_id: "shared" }),
      notice({ notice_id: "unique-2" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.candidates).toBe(2);
    expect(out.enqueued).toBe(2);
  });

  it("clamps sinceDays to SAM.gov's one-year window", async () => {
    await runGovSolicitationFinder({ ...baseConfig, sinceDays: 900 });
    expect(searchCalls[0]?.["sinceDays"]).toBe(365);
  });
});

describe("runGovSolicitationFinder — routing", () => {
  it("routes notice_type_code p (presolicitation) to sources-sought", async () => {
    nextResults = [
      notice({ notice_id: "p1", notice_type: "presolicitation", notice_type_code: "p" }),
    ];
    await runGovSolicitationFinder(baseConfig);
    expect(enqueued[0]!.playName).toBe("sources-sought");
    expect(enqueued[0]!.payload["noticeType"]).toBe("Presolicitation");
  });

  it("routes notice_type_code o (solicitation) to design-partner-loi", async () => {
    nextResults = [notice({ notice_id: "o1", notice_type: "solicitation", notice_type_code: "o" })];
    const out = await runGovSolicitationFinder({ ...baseConfig, noticeTypes: ["o"] });
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.playName).toBe("design-partner-loi");
  });

  it("falls back to the type name when the code is null — a sources-sought name still routes to sources-sought", async () => {
    nextResults = [
      notice({ notice_id: "nocode", notice_type: "sources_sought", notice_type_code: null }),
    ];
    await runGovSolicitationFinder(baseConfig);
    expect(enqueued[0]!.playName).toBe("sources-sought");
  });

  it("falls back to design-partner-loi when neither a code nor a recognisable name is present", async () => {
    nextResults = [notice({ notice_id: "other", notice_type: "other", notice_type_code: null })];
    await runGovSolicitationFinder(baseConfig);
    expect(enqueued[0]!.playName).toBe("design-partner-loi");
  });
});

describe("runGovSolicitationFinder — contact guards", () => {
  it("drops a notice with no contact carrying both a name and an email — nothing to enrich", async () => {
    nextResults = [
      notice({
        notice_id: "no-name",
        contact: { name: null, email: "no-name@gsa.gov" },
        contacts: [],
      }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
  });

  it("falls back to the contacts[] list when the primary contact is unusable", async () => {
    nextResults = [
      notice({
        notice_id: "fallback",
        contact: null,
        contacts: [
          { name: null, email: "x@gsa.gov" },
          { name: "Backup Officer", email: "backup@gsa.gov" },
        ],
      }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.payload["email"]).toBe("backup@gsa.gov");
    expect(enqueued[0]!.payload["name"]).toBe("Backup Officer");
  });

  it("drops a notice with a malformed (non-array) contacts value instead of throwing", async () => {
    nextResults = [
      notice({
        notice_id: "bad-poc",
        contact: null,
        contacts: { name: "Solo", email: "solo@gsa.gov" },
      }),
      notice({ notice_id: "good-poc" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued[0]!.dedupeKey).toBe("good-poc");
  });

  it("drops a notice with a non-string email or name in an otherwise valid contact instead of throwing", async () => {
    // The declared field types aren't contractually guaranteed at runtime —
    // `.trim()` on a number throws outside any try/catch and would abort
    // the whole enqueue loop, dropping every later notice in the batch.
    nextResults = [
      notice({ notice_id: "num-email", contact: { name: "Numeric Email", email: 12345 } }),
      notice({ notice_id: "num-name", contact: { name: 12345, email: "n@gsa.gov" } }),
      notice({ notice_id: "good-2" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(out.droppedEnrichment).toBe(2);
    expect(enqueued[0]!.dedupeKey).toBe("good-2");
  });
});

describe("runGovSolicitationFinder — filters and halts", () => {
  it("filters by agencies (case-insensitive substring) even though the SDK was asked to as well", async () => {
    const out = await runGovSolicitationFinder({
      ...baseConfig,
      agencies: ["department of defense"],
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedIcp).toBe(1);
  });

  it("halts when naics is empty, before any search", async () => {
    const out = await runGovSolicitationFinder({ ...baseConfig, naics: [] });
    expect(out.halted).toMatch(/naics/);
    expect(searchCalls).toHaveLength(0);
  });

  it("halts when noticeTypes has no valid SAM.gov code", async () => {
    const out = await runGovSolicitationFinder({ ...baseConfig, noticeTypes: ["zz"] });
    expect(out.halted).toMatch(/noticeTypes/);
    expect(searchCalls).toHaveLength(0);
  });

  it("halts with a named platform error when the search itself fails — not as 'no notices'", async () => {
    searchStatus = "error";
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.halted).toMatch(/platform error/);
    expect(out.enqueued).toBe(0);
    expect(out.candidates).toBe(0);
  });

  it("halts before the search when the cap is already exhausted", async () => {
    const out = await runGovSolicitationFinder({ ...baseConfig, maxCostUsd: 0 });
    expect(out.halted).toMatch(/max-cost cap/);
    expect(searchCalls).toHaveLength(0);
  });

  it("respects the enqueue limit", async () => {
    nextResults = [
      notice({ notice_id: "a" }),
      notice({ notice_id: "b" }),
      notice({ notice_id: "c" }),
    ];
    const out = await runGovSolicitationFinder({ ...baseConfig, limit: 2 });
    expect(out.enqueued).toBe(2);
  });
});

describe("runGovSolicitationFinder — URL and description fallbacks", () => {
  it("falls back to the sam.gov opp URL when the SDK carries no url", async () => {
    nextResults = [notice({ notice_id: "nourl", url: null })];
    await runGovSolicitationFinder(baseConfig);
    expect(enqueued[0]!.payload["noticeUrl"]).toBe("https://sam.gov/opp/nourl/view");
  });

  it("enqueues without a descriptionSnippet when the SDK returned no description", async () => {
    nextResults = [notice({ notice_id: "nodesc", description: null })];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.payload["descriptionSnippet"]).toBeUndefined();
  });

  it("caps the description snippet at 800 characters", async () => {
    nextResults = [notice({ notice_id: "long", description: "x".repeat(2000) })];
    await runGovSolicitationFinder(baseConfig);
    expect((enqueued[0]!.payload["descriptionSnippet"] as string).length).toBe(800);
  });
});

describe("runGovSolicitationFinder — expired response deadlines", () => {
  it("drops a notice whose response deadline has already passed", async () => {
    nextResults = [notice({ notice_id: "expired", response_deadline: "2020-01-01" })];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
  });

  it("keeps a notice with an unparseable deadline — fails open rather than guessing", async () => {
    nextResults = [notice({ notice_id: "garbage", response_deadline: "not-a-date" })];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
  });

  it("does not enqueue an expired notice in dry-run either — the preview should match a live run", async () => {
    nextResults = [notice({ notice_id: "expired-dry", response_deadline: "2020-01-01" })];
    const out = await runGovSolicitationFinder({ ...baseConfig, dryRun: true });
    expect(out.enqueued).toBe(0);
  });
});

describe("runGovSolicitationFinder — dedupe", () => {
  it("drops a notice already queued under either route", async () => {
    queueDuplicate = true;
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.droppedDuplicate).toBe(1);
    expect(enqueued).toHaveLength(0);
  });

  it("drops a second distinct notice sharing an already-known prospect email", async () => {
    findProspectByEmailResult = { id: 1 };
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedDuplicate).toBe(1);
  });

  it("drops a notice whose contact email is already pending in the queue under another play", async () => {
    emailPendingInQueue = true;
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.droppedDuplicate).toBe(1);
  });
});

describe("runGovSolicitationFinder — dry run", () => {
  it("counts without enqueuing, but still pays for and counts the one search", async () => {
    const out = await runGovSolicitationFinder({ ...baseConfig, dryRun: true });
    expect(out.enqueued).toBe(1);
    expect(out.costUsd).toBe(0.02);
    expect(enqueued).toHaveLength(0);
  });
});

describe("runGovSolicitationFinder — malformed result elements", () => {
  it("drops a null/malformed element without failing the whole run", async () => {
    nextResults = [null, "unexpected-string", notice({ notice_id: "good-1" })];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.candidates).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.dedupeKey).toBe("good-1");
  });

  it("drops an element with a missing/blank notice_id rather than producing an `undefined` dedupe key", async () => {
    nextResults = [
      notice({ notice_id: undefined }),
      notice({ notice_id: "" }),
      notice({ notice_id: "good-2" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.candidates).toBe(1);
    expect(enqueued[0]!.dedupeKey).toBe("good-2");
  });
});

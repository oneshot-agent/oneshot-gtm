import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for runGovSolicitationFinder — mocks the SAM.gov HTTP
// boundary (plain fetch, no OneShot SDK) and the ledger. Unlike every other
// finder, this one makes NO findEmail/verifyEmail/enrichProfile calls at
// all — the notice's own pointOfContact is the contact — so there is no SDK
// mock surface to set up.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}

const enqueued: EnqueuedRow[] = [];
const pendingPersisted: Array<{
  playName: string;
  dedupeKey: string;
  source: string;
  raw: unknown;
}> = [];
let searchResponses: Record<string, unknown> = {};
let searchStatus = 200;
let searchThrows = false;
let descriptionText: string | null = "Full RFP body text.";
let descriptionStatus = 200;
let descriptionThrows = false;
let descriptionJsonThrows = false;
let findProspectByEmailResult: { id: number } | null = null;
let emailPendingInQueue = false;

vi.mock("../src/_pending.ts", () => ({
  persistPending: (input: {
    playName: string;
    dedupeKey: string;
    source: string;
    raw: unknown;
  }) => {
    pendingPersisted.push(input);
  },
  registerPendingRetry: () => {},
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({
      isQueueDuplicate: () => false,
      isPendingResolution: () => false,
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

function samOpportunity(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    noticeId: "abc123",
    title: "AI-assisted document review pilot",
    solicitationNumber: "47PF0018R0023",
    fullParentPathName: "GENERAL SERVICES ADMINISTRATION",
    postedDate: "2026-08-01",
    type: "Sources Sought",
    baseType: "Sources Sought",
    naicsCode: "541511",
    responseDeadLine: "2026-12-01",
    pointOfContact: [
      {
        type: "primary",
        title: "Contracting Officer",
        fullName: "Jesse L. Jones",
        email: "jesse.jones@gsa.gov",
        phone: "2174941263",
      },
    ],
    description: "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=abc123",
    uiLink: "https://sam.gov/opp/abc123/view",
    ...overrides,
  };
}

beforeEach(() => {
  process.env["SAM_GOV_API_KEY"] = "test-key";
  enqueued.length = 0;
  pendingPersisted.length = 0;
  searchResponses = { "541511": [samOpportunity()] };
  searchStatus = 200;
  searchThrows = false;
  descriptionText = "Full RFP body text.";
  descriptionStatus = 200;
  descriptionThrows = false;
  descriptionJsonThrows = false;
  findProspectByEmailResult = null;
  emailPendingInQueue = false;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("noticedesc")) {
        if (descriptionThrows) throw new Error("network down");
        if (descriptionStatus !== 200) {
          return { ok: false, status: descriptionStatus, json: async () => ({}) };
        }
        if (descriptionJsonThrows) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new Error("invalid json");
            },
          };
        }
        return { ok: true, status: 200, json: async () => ({ description: descriptionText }) };
      }
      if (searchThrows) throw new Error("network down");
      if (searchStatus !== 200) {
        return { ok: false, status: searchStatus, json: async () => ({}) };
      }
      const naicsMatch = /ncode=([^&]+)/.exec(url);
      const naics = naicsMatch ? decodeURIComponent(naicsMatch[1]!) : "";
      const opportunitiesData = (searchResponses[naics] as unknown[]) ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ totalRecords: opportunitiesData.length, opportunitiesData }),
      };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["SAM_GOV_API_KEY"];
});

const baseConfig = {
  dryRun: false,
  naics: ["541511"],
  noticeTypes: ["r", "p"],
  yourEdge: "we cut review time in half",
  sinceDays: 30,
  limit: 25,
};

describe("runGovSolicitationFinder — happy path", () => {
  it("enqueues a notice carrying the notice number, type, and published POC email — no SDK spend", async () => {
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(out.costUsd).toBe(0);
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("sources-sought"); // Sources Sought → sources-sought
    expect(row.payload["noticeNumber"]).toBe("47PF0018R0023");
    expect(row.payload["noticeType"]).toBe("Sources Sought");
    expect(row.payload["email"]).toBe("jesse.jones@gsa.gov");
    expect(row.payload["name"]).toBe("Jesse L. Jones");
    expect(row.payload["phone"]).toBe("2174941263");
    expect(row.payload["descriptionSnippet"]).toContain("Full RFP body text.");
  });

  it("routes a non-sources-sought/presolicitation notice type to design-partner-loi", async () => {
    searchResponses["541511"] = [
      samOpportunity({ noticeId: "def456", type: "Solicitation", baseType: "Solicitation" }),
    ];
    const out = await runGovSolicitationFinder({ ...baseConfig, noticeTypes: ["o"] });
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.playName).toBe("design-partner-loi");
  });

  it("drops a notice with no POC carrying both a name and an email — nothing to enrich", async () => {
    searchResponses["541511"] = [
      samOpportunity({ noticeId: "noc-poc", pointOfContact: [{ email: "no-name@gsa.gov" }] }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
  });

  it("drops a notice with a malformed (non-array) pointOfContact instead of throwing", async () => {
    // SAM.gov's per-element shape isn't contractually guaranteed — a single
    // object (or any other non-array value) in place of the expected list
    // must not crash the `for...of` in pickPoc and abort the whole batch.
    searchResponses["541511"] = [
      samOpportunity({
        noticeId: "bad-poc",
        pointOfContact: { email: "solo@gsa.gov", fullName: "Solo Object" } as unknown as unknown[],
      }),
      samOpportunity({ noticeId: "good-poc" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.dedupeKey).toBe("good-poc");
  });

  it("drops a notice with non-string email/fullName in an otherwise valid POC entry instead of throwing", async () => {
    // The declared `SamPointOfContact` field types aren't contractually
    // guaranteed at runtime — a single POC object can carry a non-string
    // `email` or `fullName` (e.g. a number). `.trim()` on a non-string
    // throws a TypeError outside any try/catch here, which would abort the
    // whole enqueue loop and drop every later opportunity in the batch.
    searchResponses["541511"] = [
      samOpportunity({
        noticeId: "bad-poc-types",
        pointOfContact: [{ email: 12345, fullName: "Numeric Email" }] as unknown as unknown[],
      }),
      samOpportunity({ noticeId: "good-poc-2" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.dedupeKey).toBe("good-poc-2");
  });

  it("filters by agencies (case-insensitive substring) before any fetch", async () => {
    const out = await runGovSolicitationFinder({
      ...baseConfig,
      agencies: ["department of defense"],
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedIcp).toBe(1);
  });

  it("sweeps multiple NAICS codes and dedupes overlapping notice IDs", async () => {
    searchResponses = {
      "541511": [samOpportunity({ noticeId: "shared" })],
      "541512": [samOpportunity({ noticeId: "shared" }), samOpportunity({ noticeId: "unique-2" })],
    };
    const out = await runGovSolicitationFinder({ ...baseConfig, naics: ["541511", "541512"] });
    expect(out.candidates).toBe(2); // shared counted once
    expect(out.enqueued).toBe(2);
  });
});

describe("runGovSolicitationFinder — readiness / halts", () => {
  it("halts when SAM_GOV_API_KEY is unset", async () => {
    delete process.env["SAM_GOV_API_KEY"];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.halted).toMatch(/SAM_GOV_API_KEY/);
    expect(out.enqueued).toBe(0);
  });

  it("halts when naics is empty", async () => {
    const out = await runGovSolicitationFinder({ ...baseConfig, naics: [] });
    expect(out.halted).toMatch(/naics/);
  });

  it("halts when every NAICS search fails", async () => {
    searchStatus = 500;
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.halted).toMatch(/SAM.gov search failed/);
    expect(out.enqueued).toBe(0);
  });
});

describe("runGovSolicitationFinder — transient platform errors defer to pending_resolution", () => {
  it("persists a candidate for retry when the description fetch times out, rather than dropping it", async () => {
    descriptionThrows = true;
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(pendingPersisted).toHaveLength(1);
    expect(pendingPersisted[0]!.playName).toBe("gov-solicitation");
    expect(pendingPersisted[0]!.dedupeKey).toBe("abc123");
  });

  it("persists on a 5xx from the description endpoint", async () => {
    descriptionStatus = 503;
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(pendingPersisted).toHaveLength(1);
  });

  it("proceeds without a description on a 404 (deleted notice) — a real negative, not a retry", async () => {
    descriptionStatus = 404;
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(pendingPersisted).toHaveLength(0);
    expect(enqueued[0]!.payload["descriptionSnippet"]).toBeUndefined();
  });

  it("persists for retry when a 200 response body isn't valid JSON, rather than silently enqueuing without a description", async () => {
    descriptionJsonThrows = true;
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(pendingPersisted).toHaveLength(1);
  });
});

describe("runGovSolicitationFinder — SAM.gov 'null' string sentinels", () => {
  it('falls back to the sam.gov opp URL when uiLink is the literal string "null"', async () => {
    searchResponses["541511"] = [samOpportunity({ noticeId: "nulllink", uiLink: "null" })];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.payload["noticeUrl"]).toBe("https://sam.gov/opp/nulllink/view");
  });

  it('treats a literal "null" description URL as missing — no fetch, no descriptionSnippet', async () => {
    searchResponses["541511"] = [samOpportunity({ noticeId: "nulldesc", description: "null" })];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.payload["descriptionSnippet"]).toBeUndefined();
    expect(pendingPersisted).toHaveLength(0);
  });
});

describe("runGovSolicitationFinder — expired response deadlines", () => {
  it("drops a notice whose response deadline has already passed", async () => {
    searchResponses["541511"] = [
      samOpportunity({ noticeId: "expired", responseDeadLine: "2020-01-01" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued).toHaveLength(0);
  });

  it("keeps a notice with an unparseable deadline — fails open rather than guessing", async () => {
    searchResponses["541511"] = [
      samOpportunity({ noticeId: "garbage-deadline", responseDeadLine: "not-a-date" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
  });

  it("does not enqueue an expired notice in dry-run either — the preview should match a live run", async () => {
    searchResponses["541511"] = [
      samOpportunity({ noticeId: "expired-dry", responseDeadLine: "2020-01-01" }),
    ];
    const out = await runGovSolicitationFinder({ ...baseConfig, dryRun: true });
    expect(out.enqueued).toBe(0);
  });
});

describe("runGovSolicitationFinder — cross-play email dedupe", () => {
  it("drops a second distinct notice sharing an already-known prospect email", async () => {
    findProspectByEmailResult = { id: 1 };
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedDuplicate).toBe(1);
    expect(enqueued).toHaveLength(0);
  });

  it("drops a notice whose POC email is already pending in the queue under another play", async () => {
    emailPendingInQueue = true;
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(0);
    expect(out.droppedDuplicate).toBe(1);
  });
});

describe("runGovSolicitationFinder — dry run", () => {
  it("counts without enqueuing or fetching descriptions", async () => {
    const out = await runGovSolicitationFinder({ ...baseConfig, dryRun: true });
    expect(out.enqueued).toBe(1);
    expect(enqueued).toHaveLength(0);
  });
});

describe("runGovSolicitationFinder — malformed search-response elements", () => {
  it("drops a null/malformed opportunity element without failing the whole run", async () => {
    // Regression: a search response can carry a null/malformed element
    // alongside good ones. Dereferencing `o.noticeId` on it used to throw
    // outside any try/catch, failing the whole run and losing every
    // already-fetched notice.
    searchResponses["541511"] = [
      null as unknown as Record<string, unknown>,
      "unexpected-string" as unknown as Record<string, unknown>,
      samOpportunity({ noticeId: "good-1" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.candidates).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.dedupeKey).toBe("good-1");
  });

  it("drops an opportunity with a missing/blank noticeId rather than producing an `undefined` dedupe key", async () => {
    searchResponses["541511"] = [
      samOpportunity({ noticeId: undefined as unknown as string }),
      samOpportunity({ noticeId: "" }),
      samOpportunity({ noticeId: "good-2" }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.candidates).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.dedupeKey).toBe("good-2");
  });
});

describe("runGovSolicitationFinder — description-fetch SSRF guard", () => {
  it("skips the description fetch (and enqueues without it) when descriptionUrl isn't an https://api.sam.gov/... URL", async () => {
    // Regression: `description` is a URL SAM.gov controls today, but the
    // fetch code must not trust it blindly — it carries the SAM_GOV_API_KEY
    // as a query param. A response pointing anywhere else must never see
    // the key attached.
    const fetchSpy = vi.fn(globalThis.fetch as unknown as (...args: unknown[]) => Promise<unknown>);
    vi.stubGlobal("fetch", fetchSpy);
    searchResponses["541511"] = [
      samOpportunity({
        noticeId: "evil-host",
        description: "https://evil.example.com/noticedesc?noticeid=evil-host",
      }),
    ];
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(enqueued[0]!.payload["descriptionSnippet"]).toBeUndefined();
    // Only the search call should have hit fetch — never the malicious host.
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("evil.example.com"))).toBe(false);
  });

  it("passes `redirect: error` on the description fetch so a 3xx never auto-follows with the api_key attached", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("noticedesc")) {
          capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ description: "text" }) };
        }
        const naicsMatch = /ncode=([^&]+)/.exec(url);
        const naics = naicsMatch ? decodeURIComponent(naicsMatch[1]!) : "";
        const opportunitiesData = (searchResponses[naics] as unknown[]) ?? [];
        return {
          ok: true,
          status: 200,
          json: async () => ({ totalRecords: opportunitiesData.length, opportunitiesData }),
        };
      }),
    );
    const out = await runGovSolicitationFinder(baseConfig);
    expect(out.enqueued).toBe(1);
    expect(capturedInit?.redirect).toBe("error");
  });
});

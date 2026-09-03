import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Round-2 review finding: local-registry.test.ts mocks
// `../src/_findemail-prescreen.ts` wholesale (`shouldSkipFindEmail: () => ({
// ok: true })`), which hid the real prescreen unconditionally rejecting
// every non-knownEmail registry candidate with `no-fullname` (fullName was
// always passed as `null` with no opt-in). This file exercises the REAL
// `shouldSkipFindEmail` — everything else is stubbed the same way
// local-registry.test.ts does it — so a regression that drops the
// `allowMissingFullName: true` opt-in on the call site (local-registry.ts)
// fails this test instead of being invisible behind the mock.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}
const enqueued: EnqueuedRow[] = [];
let findEmailCalls = 0;

vi.mock("../src/_registry-sources.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_registry-sources.ts")>(
    "../src/_registry-sources.ts",
  );
  return {
    ...actual,
    REGISTRY_SOURCES: [
      {
        id: "socrata-license",
        fetch: async () => ({
          records: [
            {
              name: "Real Restaurant LLC",
              address: "1 Main St",
              city: "Brooklyn",
              state: "NY",
              phone: null,
              matchedDateIso: new Date(Date.now() - 3 * 86_400_000).toISOString(),
              source: "socrata-license" as const,
              sourceLabel: "NYC licenses",
            },
          ],
          costUsd: 0,
          perSource: [{ source: "socrata-license", label: "NYC licenses", records: 1 }],
        }),
      },
      { id: "nppes", fetch: async () => ({ records: [], costUsd: 0, perSource: [] }) },
      { id: "fmcsa", fetch: async () => ({ records: [], costUsd: 0, perSource: [] }) },
      {
        id: "socrata-inspection",
        fetch: async () => ({ records: [], costUsd: 0, perSource: [] }),
      },
    ],
  };
});

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => ({ match: true, reason: "fits" }),
  hasRoleText: (p: { roleText?: string | null }) => (p.roleText ?? "").trim().length > 0,
  qualifyPerson: async () => ({ verdict: "pass", reason: "stub" }),
}));

vi.mock("../src/_enrich.ts", () => ({
  enrichVerifiedContact: async () => ({
    phone: null,
    linkedinUrl: null,
    title: null,
    summary: null,
    costUsd: 0,
    receiptId: 1,
  }),
}));

vi.mock("../src/_dedupe.ts", () => ({
  isDuplicate: () => false,
  urlDomain: () => null,
}));

// Deliberately NOT mocking ../src/_findemail-prescreen.ts — the real
// shouldSkipFindEmail runs against the real domain/name this test supplies.

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    enrichCompany: async () => ({
      result: { status: "ok", company: { domain: "realrestaurant.com" }, cost: 0.005 },
      receiptId: 2,
    }),
    findEmail: async () => {
      findEmailCalls++;
      return {
        result: { found: true, email: "hello@realrestaurant.com", cost: 0.01 },
        receiptId: 1,
      };
    },
    verifyEmail: async () => ({ result: { deliverable: true, cost: 0.005 }, receiptId: 1 }),
    getLedger: () => ({
      isQueueDuplicate: () => false,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runLocalRegistryFinder } = await import("../src/local-registry.ts");

beforeEach(() => {
  enqueued.length = 0;
  findEmailCalls = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runLocalRegistryFinder — real shouldSkipFindEmail prescreen (no mock)", () => {
  it("enqueues a fullName:null socrata-license candidate instead of being silently dropped as no-fullname", async () => {
    const out = await runLocalRegistryFinder({
      dryRun: false,
      yourEdge: "we set it up free",
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.candidates).toBe(1);
    expect(findEmailCalls).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.payload["email"]).toBe("hello@realrestaurant.com");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = new Map<string, string>();
const rows: Array<Record<string, unknown>> = [];
const updates: Array<{ id: number; payload: unknown }> = [];
const notes: Array<{ id: number; notes: string }> = [];
const calls = { read: 0, research: 0 };
let researchFails = false;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getProductResearchCache: (key: string) => cache.get(key) ?? null,
      setProductResearchCache: (key: string, value: string) => cache.set(key, value),
      listPendingQueueAfterId: () => rows,
      updateQueuePayload: (input: { id: number; payload: unknown }) => updates.push(input),
      setQueueNotes: (input: { id: number; notes: string }) => notes.push(input),
    }),
    webRead: async ({ url }: { url: string }) => {
      calls.read++;
      return {
        result: { markdown: `first-party ${url}`, cost: 0.01 },
        receiptId: 1,
      };
    },
    deepResearch: async () => {
      calls.research++;
      if (researchFails) throw new Error("provider unavailable");
      return {
        result: {
          answer: "Payments are a separate SaaS layer.",
          sources: ["https://example.com"],
          cost: 0.05,
        },
        receiptId: 2,
      };
    },
    logEvent: () => {},
  };
});

const { researchNewQueueRows, researchQueueRowProduct } =
  await import("../src/_product-research.ts");

const row = {
  id: 42,
  play_name: "stack-consolidation",
  source: "find:github-topics",
  notes: "runs tavily",
  payload_json: JSON.stringify({
    name: "Alessandro Binda",
    company: "S.C.A.L.A. AI",
    email: "ale@get-scala.com",
    evidenceUrl: "https://github.com/Alessandro114/sara",
  }),
};

beforeEach(() => {
  cache.clear();
  rows.length = 0;
  updates.length = 0;
  notes.length = 0;
  calls.read = 0;
  calls.research = 0;
  researchFails = false;
});

describe("product research", () => {
  it("combines first-party and quick external research and caches the dossier", async () => {
    const result = await researchQueueRowProduct(row, { remainingUsd: 1 });
    expect(result.dossier.status).toBe("complete");
    expect(result.dossier.subject.company).toBe("S.C.A.L.A. AI");
    expect(result.dossier.sources.some((source) => source.kind === "repository")).toBe(true);
    expect(result.costUsd).toBeCloseTo(0.07);

    const cached = await researchQueueRowProduct(row, { remainingUsd: 1 });
    expect(cached.cached).toBe(true);
    expect(cached.costUsd).toBe(0);
    expect(calls.research).toBe(1);
  });

  it("returns an explicit unavailable dossier when the cost cap is exhausted", async () => {
    const result = await researchQueueRowProduct(row, { remainingUsd: 0 });
    expect(result.dossier.status).toBe("unavailable");
    expect(result.dossier.warning).toContain("cost cap");
    expect(calls.read).toBe(0);
    expect(calls.research).toBe(0);
  });

  it("rejects syntactically valid non-object queue payloads", async () => {
    const result = await researchQueueRowProduct(
      { ...row, payload_json: "null" },
      { remainingUsd: 1 },
    );
    expect(result.dossier.status).toBe("unavailable");
    expect(result.dossier.warning).toContain("expected an object");
    expect(calls.read).toBe(0);
    expect(calls.research).toBe(0);
  });

  it("does not share contact-grounded cache entries across people", async () => {
    await researchQueueRowProduct(row, { remainingUsd: 1 });
    await researchQueueRowProduct(
      {
        ...row,
        id: 43,
        payload_json: JSON.stringify({
          name: "Another Founder",
          company: "S.C.A.L.A. AI",
          email: "other@get-scala.com",
          evidenceUrl: "https://github.com/Alessandro114/sara",
        }),
      },
      { remainingUsd: 1 },
    );
    expect(calls.research).toBe(2);
  });

  it("can backfill first-party evidence without calling external research", async () => {
    const result = await researchQueueRowProduct(row, {
      remainingUsd: 1,
      externalResearch: false,
    });
    expect(result.dossier.status).toBe("partial");
    expect(result.dossier.warning).toContain("external research disabled");
    expect(result.dossier.sources.some((source) => source.kind === "repository")).toBe(true);
    expect(calls.research).toBe(0);
  });

  it("updates newly-created pending rows before the trigger completes", async () => {
    rows.push({ ...row, status: "pending" });
    const finderResult = {
      source: "find:github-topics",
      candidates: 1,
      droppedIcp: 0,
      droppedDuplicate: 0,
      droppedEnrichment: 0,
      enqueued: 1,
      costUsd: 0,
    };
    await researchNewQueueRows({
      afterId: 0,
      result: finderResult,
      maxCostUsd: 1,
      enabled: true,
    });
    expect(updates).toHaveLength(1);
    expect((updates[0]!.payload as Record<string, unknown>)["productResearch"]).toBeTruthy();
    expect(finderResult.costUsd).toBeCloseTo(0.07);
  });

  it("does not claim rows created concurrently by another finder", async () => {
    rows.push({ ...row, source: "find:luma-events", status: "pending" });
    await researchNewQueueRows({
      afterId: 0,
      result: {
        source: "find:github-topics",
        candidates: 1,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 1,
        costUsd: 0,
      },
      maxCostUsd: 1,
      enabled: true,
    });
    expect(updates).toHaveLength(0);
    expect(calls.research).toBe(0);
  });

  it("opens a circuit after repeated external failures while retaining first-party evidence", async () => {
    researchFails = true;
    for (let i = 0; i < 4; i++) {
      const result = await researchQueueRowProduct(
        {
          ...row,
          id: 100 + i,
          payload_json: JSON.stringify({
            name: `Founder ${i}`,
            company: `Company ${i}`,
            evidenceUrl: `https://company-${i}.example`,
          }),
        },
        { remainingUsd: 1 },
      );
      expect(result.dossier.status).toBe("partial");
      expect(result.dossier.warning).toContain("first-party evidence retained");
    }
    expect(calls.research).toBe(3);

    await researchQueueRowProduct(
      {
        ...row,
        id: 200,
        payload_json: JSON.stringify({
          name: "Forced Founder",
          company: "Forced Company",
          evidenceUrl: "https://forced-company.example",
        }),
      },
      { remainingUsd: 1, externalResearch: true },
    );
    expect(calls.research).toBe(4);
  });
});

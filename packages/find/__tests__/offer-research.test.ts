import { beforeEach, describe, expect, it, vi } from "vitest";

// The company research every offer writer can ask for (plays'
// `researchForOffer`), registered by find: the queue gate decides, the
// dossier lands on a live row, and the cost comes back.

const ledger = {
  patchLiveQueuePayload: vi.fn((_input: { id: number; patch: Record<string, unknown> }) => true),
};
const researchQueueRowProduct = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, logEvent: () => {} };
});
vi.mock("../src/_product-research.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_product-research.ts")>(
    "../src/_product-research.ts",
  );
  return {
    ...actual,
    researchQueueRowProduct: (...args: unknown[]) => researchQueueRowProduct(...args),
  };
});

await import("../src/offer-research.ts");
const { researchForOffer } = await import("@oneshot-gtm/plays");

const dossier = {
  version: 1,
  status: "complete",
  researchedAt: "2026-10-26T00:00:00.000Z",
  subject: { company: "Starian" },
  sources: [{ url: "https://starian.example", kind: "website", excerpt: "Starian builds" }],
  external: { answer: "Starian sells to retailers" },
};

beforeEach(() => {
  researchQueueRowProduct.mockReset();
  ledger.patchLiveQueuePayload.mockClear();
});

describe("offer research", () => {
  it("reads a row with no complete research, saves it on the live row, and says what it cost", async () => {
    researchQueueRowProduct.mockResolvedValue({ dossier, costUsd: 0.03, cached: false });
    const target = { name: "Tiago", company: "Starian", companyDomain: "starian.example" };
    const out = await researchForOffer({
      target,
      playName: "new-business",
      queueRowId: 4,
      source: "find:x",
    });
    expect(out).toEqual({
      target: { ...target, productResearch: dossier },
      researched: true,
      costUsd: 0.03,
    });
    const read = researchQueueRowProduct.mock.calls[0]![0] as { id: number; payload_json: string };
    expect(read.id).toBe(4);
    expect(JSON.parse(read.payload_json)).toEqual(target);
    expect(ledger.patchLiveQueuePayload.mock.calls.map((c) => c[0])).toEqual([
      { id: 4, patch: { productResearch: null } },
      { id: 4, patch: { productResearch: dossier } },
    ]);
  });

  it("leaves a row with complete research as it is", async () => {
    const target = {
      company: "Starian",
      companyDomain: "starian.example",
      productResearch: dossier,
    };
    const out = await researchForOffer({
      target,
      playName: "new-business",
      queueRowId: 4,
      source: "find:x",
    });
    expect(out).toEqual({ target, researched: false, costUsd: 0 });
    expect(researchQueueRowProduct).not.toHaveBeenCalled();
  });
});

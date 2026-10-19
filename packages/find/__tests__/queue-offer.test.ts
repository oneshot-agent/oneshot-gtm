import { beforeEach, describe, expect, it, vi } from "vitest";

// A queue row's offer is written once, stored on the live row, and re-read
// so callers compare against the stored payload text.

const ledger = {
  patchLiveQueuePayload: vi.fn((_input: { id: number; patch: Record<string, unknown> }) => true),
  getQueueRow: vi.fn((id: number) => ({ id, payload_json: '{"stored":true}' })),
  listPendingQueueAfterId: vi.fn((_id: number): unknown[] => []),
};
const ensureOfferSet = vi.fn();
const researchQueueRowProduct = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, logEvent: () => {} };
});
vi.mock("@oneshot-gtm/plays", async () => ({
  playMakesOffer: (play: string) => play !== "pmf-survey",
  ensureOfferSet: (...args: unknown[]) => ensureOfferSet(...args),
  activeOfferPatch: (
    await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")
  ).activeOfferPatch,
}));

vi.mock("../src/_product-research.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_product-research.ts")>(
    "../src/_product-research.ts",
  );
  return {
    ...actual,
    researchQueueRowProduct: (...args: unknown[]) => researchQueueRowProduct(...args),
  };
});

const { ensureQueueRowOffer, offerNewQueueRows } = await import("../src/queue-offer.ts");

const row = { id: 7, play_name: "show-hn", payload_json: '{"name":"Dana"}' };

beforeEach(() => {
  ensureOfferSet.mockReset();
  researchQueueRowProduct.mockReset();
  ledger.patchLiveQueuePayload.mockClear();
  ledger.getQueueRow.mockClear();
  ledger.listPendingQueueAfterId.mockReset();
  ledger.listPendingQueueAfterId.mockReturnValue([]);
});

describe("ensureQueueRowOffer", () => {
  it("stores the active offer and the ranked list on the live row, returning the stored payload", async () => {
    const offer = { offer: "x", steps: "a, b", angles: ["why 1", "why 2"] };
    const candidates = [offer, { offer: "y", steps: "c, d" }];
    ensureOfferSet.mockResolvedValue({ offer, candidates, changed: true });
    const out = await ensureQueueRowOffer(row);
    expect(ledger.patchLiveQueuePayload).toHaveBeenCalledWith({
      id: 7,
      patch: { offer, offerCandidates: candidates },
    });
    expect(out.payload_json).toBe('{"stored":true}');
  });

  it("replaces the old offer whole, so its approval never lands on the new one", async () => {
    const offer = { offer: "x", steps: "a, b", relevance: "weak" };
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: true });
    await ensureQueueRowOffer({
      ...row,
      payload_json: JSON.stringify({
        name: "Dana",
        offer: { offer: "old", steps: "", relevance: "weak", weakApprovedAt: "2026-10-01" },
      }),
    });
    expect(ledger.patchLiveQueuePayload).toHaveBeenCalledWith({
      id: 7,
      patch: { offer: { ...offer, weakApprovedAt: null }, offerCandidates: [offer] },
    });
  });

  it("leaves a row alone when its offers are current", async () => {
    const offer = { offer: "x", steps: "a, b" };
    const current = { ...row, payload_json: JSON.stringify({ name: "Dana", offer }) };
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: false });
    expect(await ensureQueueRowOffer(current)).toBe(current);
    expect(ledger.patchLiveQueuePayload).not.toHaveBeenCalled();
  });

  it("skips a play that makes no offer", async () => {
    const survey = { ...row, play_name: "pmf-survey" };
    expect(await ensureQueueRowOffer(survey)).toBe(survey);
    expect(ensureOfferSet).not.toHaveBeenCalled();
  });

  it("never throws: a failure leaves the row as it was", async () => {
    ensureOfferSet.mockRejectedValue(new Error("model down"));
    expect(await ensureQueueRowOffer(row)).toBe(row);
  });
});

// Background paths read the company's own pages before writing offers; a
// click (draft regenerate, New offers) never waits on that read.
describe("company research before offers", () => {
  const firm = {
    id: 9,
    play_name: "design-partner-loi",
    source: "find:x",
    notes: null,
    payload_json: JSON.stringify({ name: "Ada", company: "Alpha", companyDomain: "alpha.example" }),
  };
  const pages = {
    version: 1,
    status: "partial",
    researchedAt: "2026-10-19T00:00:00.000Z",
    subject: { company: "Alpha" },
    sources: [{ url: "https://alpha.example", kind: "website", excerpt: "Alpha builds search" }],
  };
  const offer = { offer: "x", steps: "a, b" };

  it("runs before the offers on a background path, which are written from it", async () => {
    const order: string[] = [];
    researchQueueRowProduct.mockImplementation(async () => {
      order.push("research");
      return { dossier: pages, costUsd: 0.2, cached: false };
    });
    ensureOfferSet.mockImplementation(async () => {
      order.push("offers");
      return { offer, candidates: [offer], changed: true };
    });
    const costs: number[] = [];
    await ensureQueueRowOffer(firm, {
      research: true,
      researchBudgetUsd: 0.5,
      onResearchCost: (usd) => costs.push(usd),
    });
    expect(order).toEqual(["research", "offers"]);
    expect(researchQueueRowProduct.mock.calls[0]![1]).toEqual({ remainingUsd: 0.5 });
    expect(costs).toEqual([0.2]);
    const target = (ensureOfferSet.mock.calls[0]![0] as { target: Record<string, unknown> }).target;
    expect(target["productResearch"]).toEqual(pages);
    // The old dossier is cleared, then the new one written, on the live row.
    expect(ledger.patchLiveQueuePayload.mock.calls.map((c) => c[0].patch)).toEqual([
      { productResearch: null },
      { productResearch: pages },
      { offer, offerCandidates: [offer] },
    ]);
  });

  it("never runs on the click path", async () => {
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: true });
    await ensureQueueRowOffer(firm);
    expect(researchQueueRowProduct).not.toHaveBeenCalled();
  });

  it("is skipped when the row has page text, no company domain, or a fresh attempt", async () => {
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: false });
    const withPages = {
      ...firm,
      payload_json: JSON.stringify({ companyDomain: "alpha.example", productResearch: pages }),
    };
    const personal = { ...firm, payload_json: JSON.stringify({ email: "ada@gmail.com" }) };
    const fresh = {
      ...firm,
      payload_json: JSON.stringify({
        companyDomain: "alpha.example",
        productResearch: { ...pages, sources: [], researchedAt: new Date().toISOString() },
      }),
    };
    for (const r of [withPages, personal, fresh]) await ensureQueueRowOffer(r, { research: true });
    expect(researchQueueRowProduct).not.toHaveBeenCalled();
  });

  it("still writes offers from what is stored when the read fails or is over budget", async () => {
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: true });
    researchQueueRowProduct.mockRejectedValueOnce(new Error("read failed"));
    await ensureQueueRowOffer(firm, { research: true });
    researchQueueRowProduct.mockResolvedValueOnce({
      dossier: { ...pages, status: "unavailable", sources: [], warning: "cost cap reached" },
      costUsd: 0,
      cached: false,
    });
    await ensureQueueRowOffer(firm, { research: true });
    expect(ensureOfferSet).toHaveBeenCalledTimes(2);
    expect(ledger.patchLiveQueuePayload.mock.calls.map((c) => c[0].patch)).toEqual([
      { offer, offerCandidates: [offer] },
      { offer, offerCandidates: [offer] },
    ]);
  });

  it("a finder run's new rows are read within the run's remaining budget", async () => {
    ledger.listPendingQueueAfterId.mockReturnValue([firm]);
    researchQueueRowProduct.mockResolvedValue({ dossier: pages, costUsd: 0.3, cached: false });
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: true });
    const result = { source: "find:x", costUsd: 4.5 } as never as Parameters<
      typeof offerNewQueueRows
    >[0]["result"];
    await offerNewQueueRows({ afterId: 0, result, research: { enabled: true, maxCostUsd: 5 } });
    expect(researchQueueRowProduct.mock.calls[0]![1]).toEqual({ remainingUsd: 0.5 });
    expect(result.costUsd).toBeCloseTo(4.8);

    researchQueueRowProduct.mockClear();
    await offerNewQueueRows({ afterId: 0, result, research: { enabled: false } });
    expect(researchQueueRowProduct).not.toHaveBeenCalled();
  });
});

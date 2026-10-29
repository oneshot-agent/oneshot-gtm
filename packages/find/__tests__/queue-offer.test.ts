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
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    playMakesOffer: (play: string) => play !== "pmf-survey",
    ensureOfferSet: (...args: unknown[]) => ensureOfferSet(...args),
    activeOfferPatch: actual.activeOfferPatch,
    isOfferSkipped: actual.isOfferSkipped,
    offerSkipPatch: actual.offerSkipPatch,
  };
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
      patch: { offer, offerCandidates: candidates, offerSkip: null },
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
      patch: {
        offer: { ...offer, weakApprovedAt: null },
        offerCandidates: [offer],
        offerSkip: null,
      },
    });
  });

  it("leaves a row alone when its offers are current", async () => {
    const offer = { offer: "x", steps: "a, b" };
    const current = { ...row, payload_json: JSON.stringify({ name: "Dana", offer }) };
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: false });
    expect(await ensureQueueRowOffer(current)).toBe(current);
    expect(ledger.patchLiveQueuePayload).not.toHaveBeenCalled();
  });

  const skip = {
    why: "They left the firm and no longer hold the role.",
    version: "offer-v4",
    inputHash: "h1",
    productHash: "p1",
    skippedAt: "2026-10-22T00:00:00.000Z",
  };

  it("keeps a fresh writer skip on the live row, with its why", async () => {
    ensureOfferSet.mockResolvedValue({ skipped: skip, changed: true });
    const out = await ensureQueueRowOffer(row);
    expect(ledger.patchLiveQueuePayload).toHaveBeenCalledWith({
      id: 7,
      patch: { offerSkip: skip, offer: null, offerCandidates: null },
    });
    expect(out.payload_json).toBe('{"stored":true}');
  });

  it("a fresh skip deletes the weak set it replaces, and the draft in hand reads no offer", async () => {
    const weak = { offer: "old", steps: "", relevance: "weak", version: "offer-v6" };
    ensureOfferSet.mockResolvedValue({ skipped: skip, changed: true });
    ledger.patchLiveQueuePayload.mockReturnValueOnce(false);
    const out = await ensureQueueRowOffer({
      ...row,
      payload_json: JSON.stringify({ name: "Dana", offer: weak, offerCandidates: [weak] }),
    });
    expect(ledger.patchLiveQueuePayload.mock.calls[0]![0].patch).toEqual({
      offerSkip: skip,
      offer: null,
      offerCandidates: null,
    });
    expect(JSON.parse(out.payload_json)).toEqual({ name: "Dana", offerSkip: skip });
  });

  it("writes nothing when the stored skip still stands", async () => {
    const current = { ...row, payload_json: JSON.stringify({ name: "Dana", offerSkip: skip }) };
    ensureOfferSet.mockResolvedValue({ skipped: skip, changed: false });
    expect(await ensureQueueRowOffer(current)).toBe(current);
    expect(ledger.patchLiveQueuePayload).not.toHaveBeenCalled();
  });

  it("drops a skip left over from older research when nothing could be written now", async () => {
    ensureOfferSet.mockResolvedValue(null);
    await ensureQueueRowOffer({
      ...row,
      payload_json: JSON.stringify({ name: "Dana", offerSkip: skip }),
    });
    expect(ledger.patchLiveQueuePayload).toHaveBeenCalledWith({
      id: 7,
      patch: { offerSkip: null },
    });
  });

  it("drops the skip when an offer is written", async () => {
    const offer = { offer: "x", steps: "a, b" };
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: true });
    ledger.patchLiveQueuePayload.mockReturnValueOnce(false);
    const out = await ensureQueueRowOffer({
      ...row,
      payload_json: JSON.stringify({ name: "Dana", offerSkip: skip }),
    });
    expect(ledger.patchLiveQueuePayload.mock.calls[0]![0].patch).toMatchObject({
      offerSkip: null,
    });
    // A write that did not land still hands the draft the offer, without the skip.
    expect(JSON.parse(out.payload_json)).toEqual({
      name: "Dana",
      offer,
      offerCandidates: [offer],
    });
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

// Background paths and Regenerate draft read the company's research before
// writing offers; a click waits for that read only so long.
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
      { offer, offerCandidates: [offer], offerSkip: null },
    ]);
  });

  it("never runs unasked; the offers then carry the row for a weak set's own read", async () => {
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: true });
    await ensureQueueRowOffer(firm);
    expect(researchQueueRowProduct).not.toHaveBeenCalled();
    expect(ensureOfferSet.mock.calls[0]![0]).toMatchObject({
      research: { queueRowId: 9, source: "find:x" },
    });
    // Asked for here, it is not asked for again by the writer.
    researchQueueRowProduct.mockResolvedValue({ dossier: pages, costUsd: 0, cached: true });
    await ensureQueueRowOffer(firm, { research: true });
    expect(ensureOfferSet.mock.calls[1]![0]).not.toHaveProperty("research");
  });

  it("is skipped when the research is complete, there is no company, or a fresh attempt", async () => {
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: false });
    const complete = {
      ...firm,
      payload_json: JSON.stringify({
        companyDomain: "alpha.example",
        productResearch: { ...pages, status: "complete", external: { answer: "a" } },
      }),
    };
    const personal = { ...firm, payload_json: JSON.stringify({ email: "ada@gmail.com" }) };
    const fresh = {
      ...firm,
      payload_json: JSON.stringify({
        companyDomain: "alpha.example",
        productResearch: { ...pages, sources: [], researchedAt: new Date().toISOString() },
      }),
    };
    for (const r of [complete, personal, fresh]) await ensureQueueRowOffer(r, { research: true });
    expect(researchQueueRowProduct).not.toHaveBeenCalled();
  });

  it("reads again a row whose only research is a homepage read, or that has only a company name", async () => {
    // The Starian shape: one excerpt (a cookie banner), no outside research, read days ago.
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: false });
    researchQueueRowProduct.mockResolvedValue({ dossier: pages, costUsd: 0.01, cached: false });
    const homepageOnly = {
      ...firm,
      payload_json: JSON.stringify({ companyDomain: "alpha.example", productResearch: pages }),
    };
    const nameOnly = {
      ...firm,
      payload_json: JSON.stringify({ name: "Ada", company: "Alpha", email: "ada@qq.com" }),
    };
    const unknown = { ...firm, payload_json: JSON.stringify({ company: "(unknown)" }) };
    for (const r of [homepageOnly, nameOnly, unknown]) {
      await ensureQueueRowOffer(r, { research: true });
    }
    expect(researchQueueRowProduct).toHaveBeenCalledTimes(2);
  });

  it("a click waits for the read only so long; a late read lands on the row afterwards", async () => {
    vi.useFakeTimers();
    try {
      const read: { land?: (v: unknown) => void } = {};
      researchQueueRowProduct.mockImplementation(
        () => new Promise((resolve) => (read.land = resolve)),
      );
      ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: true });
      const pending = ensureQueueRowOffer(firm, { research: true, researchWaitMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      // Offers written from what was stored; the read has not landed.
      const target = (ensureOfferSet.mock.calls[0]![0] as { target: Record<string, unknown> })
        .target;
      expect(target["productResearch"]).toBeUndefined();
      expect(ledger.patchLiveQueuePayload.mock.calls.map((c) => c[0].patch)).toEqual([
        { offer, offerCandidates: [offer], offerSkip: null },
      ]);
      read.land?.({ dossier: pages, costUsd: 0.2, cached: false });
      await vi.waitFor(() =>
        expect(ledger.patchLiveQueuePayload.mock.calls.map((c) => c[0].patch)).toContainEqual({
          productResearch: pages,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
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
      { offer, offerCandidates: [offer], offerSkip: null },
      { offer, offerCandidates: [offer], offerSkip: null },
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

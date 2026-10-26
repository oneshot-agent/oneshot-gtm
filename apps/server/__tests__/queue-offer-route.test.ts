import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/queue/:id/offer: the founder's own offer is saved as theirs;
// a fresh one comes from the row's research; only live rows change.

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  patched: [] as Array<{ id: number; patch: Record<string, unknown>; expect?: unknown }>,
  /** Writes whose compare-and-set held: what actually landed. */
  written: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  /** The payload as the ledger holds it at write time; null: the row as read. */
  dbPayload: null as null | Record<string, unknown>,
  live: true,
  derived: null as null | Record<string, unknown>,
  /** The writer declines with this skip (wins over `derived`). */
  skipped: null as null | Record<string, unknown>,
  brief: "Acme books crews into open slots.",
  /** What each fresh set was asked for. */
  deriveInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  loadConfig: () => ({ productBrief: state.brief }),
  getLedger: () => ({
    getQueueRow: () => state.row,
    getTrigger: () => null,
    patchLiveQueuePayload: (input: {
      id: number;
      patch: Record<string, unknown>;
      expect?: Array<{ path: string; value: string | null }>;
    }) => {
      state.patched.push(input);
      const db =
        state.dbPayload ??
        (JSON.parse(String(state.row?.["payload_json"] ?? "{}")) as Record<string, unknown>);
      // The guard as the ledger checks it: `$.a.b` must still hold the value (null: absent).
      const holds = (input.expect ?? []).every(
        (g) =>
          (g.path
            .slice(2)
            .split(".")
            .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], db) ??
            null) === g.value,
      );
      if (!state.live || !holds) return false;
      state.written.push(input);
      return true;
    },
  }),
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  deriveOfferSet: async (input: Record<string, unknown>) => {
    state.deriveInputs.push(input);
    if (state.skipped) return { skipped: state.skipped };
    return state.derived
      ? { offer: state.derived, candidates: [state.derived, { offer: "second" }] }
      : null;
  },
  // Angles are written for whichever offer becomes active.
  withOfferAngles: async (offer: Record<string, unknown>) => ({ ...offer, angles: ["why"] }),
}));

const { queueOfferRoute } = await import("../src/api/queue-offer.ts");

function post(body: unknown): Request {
  return new Request("http://x/api/queue/5/offer", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  state.row = {
    id: 5,
    play_name: "show-hn",
    status: "approved",
    source: "show-hn",
    payload_json: JSON.stringify({
      name: "Dana",
      offer: {
        offer: "old",
        steps: "a, b",
        evidence: ["e"],
        stage: "startup",
        level: "researched",
      },
    }),
  };
  state.patched = [];
  state.written = [];
  state.dbPayload = null;
  state.live = true;
  state.derived = null;
  state.skipped = null;
  state.brief = "Acme books crews into open slots.";
  state.deriveInputs = [];
});

describe("queueOfferRoute", () => {
  it("saves the founder's offer as theirs, without the old offer's reasoning", async () => {
    const res = await queueOfferRoute(
      post({ offer: "  new offer  ", return: " cash collected " }),
      { id: "5" },
    );
    expect(res.status).toBe(200);
    const offer = state.patched[0]!.patch["offer"] as Record<string, unknown>;
    expect(offer).toMatchObject({
      offer: "new offer",
      steps: "",
      evidence: [],
      return: "cash collected",
      angles: ["why"],
      editedBy: "founder",
    });
  });

  it("refuses a founder's offer when there is no product brief", async () => {
    state.brief = "";
    expect((await queueOfferRoute(post({ offer: "x" }), { id: "5" })).status).toBe(422);
    expect(state.patched).toHaveLength(0);
  });

  it("refuses a body that is not a JSON object", async () => {
    expect((await queueOfferRoute(post(null), { id: "5" })).status).toBe(400);
  });

  it("writes a fresh one on regenerate", async () => {
    state.derived = { offer: "fresh", steps: "x, y" };
    const res = await queueOfferRoute(post({ regenerate: true }), { id: "5" });
    expect(res.status).toBe(200);
    // The old offer's keys the new one lacks are deleted, not merged onto it.
    expect(state.patched[0]!.patch["offer"]).toEqual({
      ...state.derived,
      evidence: null,
      stage: null,
      level: null,
    });
    expect(state.patched[0]!.patch["offerCandidates"]).toEqual([
      state.derived,
      { offer: "second" },
    ]);
  });

  it("asks for jobs other than the ones on screen, and lets a weak set read the firm first", async () => {
    const { CLICK_RESEARCH_WAIT_MS } = await import("@oneshot-gtm/find");
    const payload = JSON.parse(String(state.row!["payload_json"])) as Record<string, unknown>;
    state.row!["payload_json"] = JSON.stringify({
      ...payload,
      offerCandidates: [payload["offer"], { offer: "other", steps: "c, d" }],
    });
    state.derived = { offer: "fresh", steps: "x, y" };
    expect((await queueOfferRoute(post({ regenerate: true }), { id: "5" })).status).toBe(200);
    expect(state.deriveInputs[0]).toMatchObject({
      avoid: ["old", "other"],
      research: { queueRowId: 5, source: "show-hn", waitMs: CLICK_RESEARCH_WAIT_MS },
    });
  });

  it("keeps a writer skip on the row and answers 422 with its why, leaving the offer", async () => {
    state.skipped = {
      why: "They left the firm in October",
      version: "offer-v4",
      inputHash: "h",
      productHash: "p",
      skippedAt: "2026-10-22T00:00:00.000Z",
    };
    const res = await queueOfferRoute(post({ regenerate: true }), { id: "5" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("No offer: They left the firm in October");
    expect(body["offerSkip"]).toEqual(state.skipped);
    expect(state.written).toEqual([{ id: 5, patch: { offerSkip: state.skipped } }]);
  });

  it("drops a stored skip when the founder writes the offer", async () => {
    await queueOfferRoute(post({ offer: "new offer" }), { id: "5" });
    expect(state.patched[0]!.patch["offerSkip"]).toBeNull();
  });

  it("makes another of the row's offers active, with its angles", async () => {
    const first = { offer: "first", steps: "a, b", angles: ["one"] };
    const second = { offer: "second", steps: "c, d", return: "cash collected" };
    state.row = {
      ...state.row!,
      payload_json: JSON.stringify({
        name: "Dana",
        offer: first,
        offerCandidates: [first, second],
      }),
    };
    const res = await queueOfferRoute(post({ select: 1 }), { id: "5" });
    expect(res.status).toBe(200);
    expect(state.patched[0]!.patch["offer"]).toEqual({ ...second, angles: ["why"] });
    expect(state.patched[0]!.patch["offerCandidates"]).toEqual([
      first,
      { ...second, angles: ["why"] },
    ]);
    expect((await queueOfferRoute(post({ select: 7 }), { id: "5" })).status).toBe(400);
  });

  it("says so when no offer can be written", async () => {
    const res = await queueOfferRoute(post({ regenerate: true }), { id: "5" });
    expect(res.status).toBe(422);
    expect(state.patched).toHaveLength(0);
  });

  it("refuses an empty offer and a play that makes no offer", async () => {
    expect((await queueOfferRoute(post({ offer: " " }), { id: "5" })).status).toBe(400);
    state.row = { ...state.row!, play_name: "pmf-survey" };
    expect((await queueOfferRoute(post({ offer: "x" }), { id: "5" })).status).toBe(400);
  });

  it("leaves a row that is no longer live", async () => {
    state.live = false;
    expect((await queueOfferRoute(post({ offer: "x" }), { id: "5" })).status).toBe(409);
  });

  describe("approveWeak", () => {
    const weak = {
      offer: "old",
      steps: "a, b",
      evidence: [],
      stage: "startup",
      level: "researched",
      relevance: "weak",
    };
    beforeEach(() => {
      state.row = {
        ...state.row!,
        payload_json: JSON.stringify({ name: "Dana", offer: weak, offerCandidates: [weak] }),
      };
    });

    it("stamps the approval on the active offer only", async () => {
      const res = await queueOfferRoute(post({ approveWeak: true }), { id: "5" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { offer: Record<string, unknown> };
      expect(body.offer).toMatchObject({ ...weak, weakApprovedAt: expect.any(String) });
      expect(state.written).toEqual([
        expect.objectContaining({
          id: 5,
          patch: { offer: { weakApprovedAt: body.offer["weakApprovedAt"] } },
        }),
      ]);
    });

    it("approves nothing when another offer became active after it was read", async () => {
      const other = { ...weak, offer: "a different weak offer", derivedAt: "later" };
      state.dbPayload = { name: "Dana", offer: other, offerCandidates: [weak, other] };
      const res = await queueOfferRoute(post({ approveWeak: true }), { id: "5" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("its offer changed");
      expect(state.written).toHaveLength(0);
    });

    it("refuses an offer that is not rated weak, or is the founder's", async () => {
      for (const offer of [
        { ...weak, relevance: "relevant" },
        { ...weak, editedBy: "founder" },
      ]) {
        state.row = { ...state.row!, payload_json: JSON.stringify({ offer }) };
        expect((await queueOfferRoute(post({ approveWeak: true }), { id: "5" })).status).toBe(400);
      }
      expect(state.patched).toHaveLength(0);
    });

    it("refuses a row that is no longer live", async () => {
      state.live = false;
      expect((await queueOfferRoute(post({ approveWeak: true }), { id: "5" })).status).toBe(409);
    });
  });
});

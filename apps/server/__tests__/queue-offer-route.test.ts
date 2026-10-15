import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/queue/:id/offer: the founder's own offer is saved as theirs;
// a fresh one comes from the row's research; only live rows change.

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  patched: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  live: true,
  derived: null as null | Record<string, unknown>,
}));

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ({
    getQueueRow: () => state.row,
    getTrigger: () => null,
    patchLiveQueuePayload: (input: { id: number; patch: Record<string, unknown> }) => {
      state.patched.push(input);
      return state.live;
    },
  }),
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  deriveOffer: async () => state.derived,
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
  state.live = true;
  state.derived = null;
});

describe("queueOfferRoute", () => {
  it("saves the founder's offer as theirs, keeping the evidence", async () => {
    const res = await queueOfferRoute(post({ offer: "  new offer  " }), { id: "5" });
    expect(res.status).toBe(200);
    const offer = state.patched[0]!.patch["offer"] as Record<string, unknown>;
    expect(offer).toMatchObject({
      offer: "new offer",
      steps: "a, b",
      editedBy: "founder",
      evidence: ["e"],
    });
  });

  it("writes a fresh one on regenerate", async () => {
    state.derived = { offer: "fresh", steps: "x, y" };
    const res = await queueOfferRoute(post({ regenerate: true }), { id: "5" });
    expect(res.status).toBe(200);
    expect(state.patched[0]!.patch["offer"]).toEqual(state.derived);
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
});

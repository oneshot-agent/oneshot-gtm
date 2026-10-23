import { beforeEach, describe, expect, it, vi } from "vitest";

// A row whose active offer the judge rated weak is held from sending until
// the founder rewrites, replaces or approves the offer.

const state = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>,
  cleared: 0,
  weakOffer: [] as Array<boolean | undefined>,
  draft: {
    subject: "Hello",
    body: "A reviewed draft",
    flags: [],
    sent: false,
    receiptIds: [],
    dryRun: true,
  },
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  isDraining: () => false,
  getLedger: () => ({
    getQueueRow: () => row(),
    findProspectByEmail: () => null,
    getProspectById: () => null,
    claimQueueSendingMarker: () => true,
    clearQueueSendingMarker: () => state.cleared++,
  }),
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  // The real gate's contract: an ICP reject first, then the weak offer.
  sendDraftedEmail: async (opts: {
    flags: string[];
    weakOffer?: boolean;
    icp?: { verdict: string };
  }) => {
    state.weakOffer.push(opts.weakOffer);
    if (opts.icp?.verdict === "reject") opts.flags.push("off-icp");
    else if (opts.weakOffer) opts.flags.push("weak-offer");
    return { sent: false, receiptIds: [] };
  },
}));
vi.mock("../src/telemetry.ts", () => ({ reportServerExecution: () => {} }));
const { toView, sendDraftRoute } = await import("../src/api/queue.ts");

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    play_name: "show-hn",
    channel: "email",
    status: "approved",
    payload_json: JSON.stringify(state.payload),
    last_draft_json: JSON.stringify(state.draft),
    found_at: "2026-10-19 00:00:00",
    ...over,
  } as Parameters<typeof toView>[0];
}
const weakOffer = {
  offer: "cut the time a quote takes",
  steps: "drafts it",
  evidence: [],
  stage: "startup",
  level: "role",
  relevance: "weak",
  version: "v",
  inputHash: "h",
  derivedAt: "",
};
const send = () =>
  sendDraftRoute(new Request("http://localhost/api/queue/1/send-draft", { method: "POST" }), {
    id: "1",
  });

beforeEach(() => {
  state.payload = { email: "person@example.test", offer: weakOffer };
  state.cleared = 0;
  state.weakOffer = [];
});

describe("weak-offer send hold", () => {
  it("holds a row whose active offer was rated weak", () => {
    expect(toView(row()).sendHold).toEqual({
      code: "weak-offer",
      reason:
        "The offer was rated a weak fit for this firm. Rewrite it, pick another, or approve it.",
    });
  });

  it("releases it for the founder's offer, an approved one or a relevant one", () => {
    for (const offer of [
      { ...weakOffer, editedBy: "founder" },
      { ...weakOffer, weakApprovedAt: "2026-10-19T00:00:00Z" },
      { ...weakOffer, relevance: "relevant" },
      { ...weakOffer, relevance: undefined },
    ]) {
      state.payload = { email: "person@example.test", offer };
      expect(toView(row()).sendHold).toBeNull();
    }
  });

  it("does not hold a play that makes no offer, a sent row or a non-email row", () => {
    expect(toView(row({ play_name: "pmf-survey" })).sendHold).toBeNull();
    expect(toView(row({ status: "sent" })).sendHold).toBeNull();
    expect(toView(row({ channel: "linkedin" })).sendHold).toBeNull();
  });

  it("lets a fit hold win when both apply", () => {
    state.payload = { ...state.payload, icpVerdict: "reject", icpVerdictReason: "Unrelated role" };
    expect(toView(row()).sendHold).toEqual({ code: "off-icp", reason: "Unrelated role" });
  });

  it("refuses the manual send with a 409 held for the weak offer", async () => {
    const res = await send();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      held: true,
      reason: "weak-offer",
      error: expect.stringContaining("Regenerating the draft will not clear this hold"),
    });
    expect(state.weakOffer).toEqual([true]);
    expect(state.cleared).toBe(1);
  });

  it("shows the writer's skip on an unsent row with no offer, and only there", () => {
    const skip = {
      why: "They left the firm in October.",
      version: "offer-v4",
      inputHash: "h",
      productHash: "p",
      skippedAt: "2026-10-22T00:00:00.000Z",
    };
    state.payload = { email: "person@example.test", offerSkip: skip };
    expect(toView(row()).offerSkip).toEqual({ why: skip.why, at: skip.skippedAt });
    expect(toView(row({ status: "sent" }))).not.toHaveProperty("offerSkip");
    expect(toView(row({ play_name: "pmf-survey" }))).not.toHaveProperty("offerSkip");
    state.payload = { email: "person@example.test", offer: weakOffer, offerSkip: skip };
    expect(toView(row())).not.toHaveProperty("offerSkip");
    state.payload = { email: "person@example.test", offerSkip: { why: "no hash" } };
    expect(toView(row())).not.toHaveProperty("offerSkip");
  });

  it("asks the send gate for no hold once the offer is approved", async () => {
    state.payload = {
      email: "person@example.test",
      offer: { ...weakOffer, weakApprovedAt: "2026-10-19T00:00:00Z" },
    };
    await send();
    expect(state.weakOffer).toEqual([undefined]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A first touch to someone in another workspace's live sequence is held, not
// rejected: the flag stays on the draft, the row goes back to pending, and a
// later Send checks again. The shared DB is vitest.setup.ts's temp one.

const state = vi.hoisted(() => ({
  drafts: [] as Array<{ id: number; draft: { flags: string[]; body: string } }>,
  statuses: [] as Array<{ id: number; status: string }>,
  sendCalls: 0,
  draftFlags: [] as string[],
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  isDraining: () => false,
  getLedger: () => ({
    getQueueRow: () => row(),
    findProspectByEmail: () => null,
    getProspectById: () => null,
    claimQueueSendingMarker: () => true,
    clearQueueSendingMarker: () => {},
    setQueueDraft: (input: { id: number; draft: { flags: string[]; body: string } }) =>
      state.drafts.push(input),
    setQueueStatus: (input: { id: number; status: string }) => state.statuses.push(input),
  }),
}));
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    // The real pre-send dedupe; only the provider call is stubbed out.
    sendDraftedEmail: async (opts: Parameters<typeof actual.sendDraftedEmail>[0]) => {
      const { liveCadenceElsewhere, LIVE_ELSEWHERE_FLAG } = await import("@oneshot-gtm/core");
      if (liveCadenceElsewhere({ email: opts.to, linkedinUrl: opts.prospectMeta.linkedin_url })) {
        opts.flags.push(LIVE_ELSEWHERE_FLAG);
        return { sent: false, receiptIds: [] };
      }
      state.sendCalls++;
      throw new Error("provider not reached in this test");
    },
  };
});
vi.mock("../src/telemetry.ts", () => ({ reportServerExecution: () => {} }));
const { sendDraftRoute } = await import("../src/api/queue.ts");
const { queueDraftConfigKey } = await import("@oneshot-gtm/plays");
const { getSharedDb } = await import("@oneshot-gtm/core");

function row() {
  return {
    id: 1,
    play_name: "show-hn",
    channel: "email",
    status: "approved",
    payload_json: JSON.stringify({ email: "jo@acme.example", name: "Jo" }),
    last_draft_json: JSON.stringify({
      subject: "Hello",
      body: "A reviewed draft",
      flags: state.draftFlags,
      sent: false,
      receiptIds: [],
      dryRun: true,
      configKey: queueDraftConfigKey("show-hn", "email"),
    }),
    found_at: "2026-11-01 00:00:00",
  };
}
const send = () =>
  sendDraftRoute(new Request("http://localhost/api/queue/1/send-draft", { method: "POST" }), {
    id: "1",
  });
const live = (status: string) =>
  getSharedDb().syncCadencePresence(
    "beta",
    [
      {
        prospectId: 9,
        playName: "their-play",
        email: "jo@acme.example",
        linkedinUrl: null,
        status,
      },
    ],
    "all",
  );

beforeEach(() => {
  state.drafts = [];
  state.statuses = [];
  state.sendCalls = 0;
  state.draftFlags = [];
});
afterEach(() => {
  getSharedDb().syncCadencePresence("beta", [], "all");
});

describe("live-elsewhere send hold", () => {
  it("refuses the send with a 409, keeps the flag on the draft and moves the row to pending", async () => {
    live("active");
    const res = await send();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "Send held: this person is in a live sequence in workspace 'beta' (their-play). It can go once that sequence has ended.",
      held: true,
      reason: "live-elsewhere",
    });
    expect(state.drafts).toEqual([
      expect.objectContaining({
        id: 1,
        draft: expect.objectContaining({ body: "A reviewed draft", flags: ["live-elsewhere"] }),
      }),
    ]);
    expect(state.statuses).toEqual([expect.objectContaining({ id: 1, status: "pending" })]);
    expect(state.sendCalls).toBe(0);
  });

  it("does not block a draft flagged at drafting once that sequence has ended", async () => {
    state.draftFlags = ["live-elsewhere"];
    live("completed");
    await send();
    // Past the draft-flag gate and the hold: the send itself was attempted.
    expect(state.sendCalls).toBe(1);
    expect(state.statuses).toEqual([]);
  });
});

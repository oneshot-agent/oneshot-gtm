import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>,
  stored: null as null | { icp_verdict: string; icp_verdict_reason: string },
  cleared: 0,
  recipient: "",
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
    findProspectByEmail: () => (state.stored ? { id: 7 } : null),
    getProspectById: () => state.stored,
    claimQueueSendingMarker: () => true,
    clearQueueSendingMarker: () => state.cleared++,
  }),
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  sendDraftedEmail: async (opts: { flags: string[]; to: string }) => {
    state.recipient = opts.to;
    opts.flags.push("off-icp");
    return { sent: false, receiptIds: [] };
  },
}));
vi.mock("../src/telemetry.ts", () => ({ reportServerExecution: () => {} }));
const { toView, sendDraftRoute } = await import("../src/api/queue.ts");
function row() {
  return {
    id: 1,
    play_name: "luma-events",
    channel: "email",
    status: "approved",
    payload_json: JSON.stringify(state.payload),
    last_draft_json: JSON.stringify(state.draft),
    found_at: "2026-09-28 00:00:00",
  } as Parameters<typeof toView>[0];
}
beforeEach(() => {
  state.payload = {
    email: "person@example.test",
    icpVerdict: "reject",
    icpVerdictReason: "Works in an unrelated role",
  };
  state.stored = null;
  state.cleared = 0;
  state.recipient = "";
});
describe("queue fit holds", () => {
  it("exposes a fit hold even when the row is approved", () => {
    expect(toView(row())).toMatchObject({
      status: "approved",
      sendHold: { code: "off-icp", reason: "Works in an unrelated role" },
    });
  });
  it("uses stored fit only without a valid fresh verdict", () => {
    state.stored = { icp_verdict: "reject", icp_verdict_reason: "Stored rejection" };
    state.payload = { email: "person@example.test" };
    expect(toView(row()).sendHold?.reason).toBe("Stored rejection");
    for (const verdict of ["pass", "unclear"]) {
      state.payload.icpVerdict = verdict;
      expect(toView(row()).sendHold).toBeNull();
    }
  });
  it("does not label sent or non-email rows as email fit holds", () => {
    for (const changed of [{ status: "sent" }, { channel: "linkedin" }, { channel: "x" }])
      expect(toView({ ...row(), ...changed } as Parameters<typeof toView>[0]).sendHold).toBeNull();
  });
  it("returns an actionable 409 and clears the sending marker without changing approval or draft", async () => {
    const before = row();
    const res = await sendDraftRoute(
      new Request("http://localhost/api/queue/1/send-draft", { method: "POST" }),
      { id: "1" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      held: true,
      reason: "off-icp",
      error: expect.stringContaining("Works in an unrelated role"),
    });
    expect(state.cleared).toBe(1);
    expect(row()).toEqual(before);
  });
});

it.each(["", "   "])("uses founderEmail consistently when email is %j", async (email) => {
  state.payload = { email, founderEmail: "founder@example.test" };
  state.stored = { icp_verdict: "reject", icp_verdict_reason: "Stored founder assessment" };
  expect(toView(row()).sendHold?.reason).toBe("Stored founder assessment");
  const res = await sendDraftRoute(
    new Request("http://localhost/api/queue/1/send-draft", { method: "POST" }),
    { id: "1" },
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ reason: "off-icp" });
  expect(state.recipient).toBe("founder@example.test");
  expect(state.cleared).toBe(1);
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// A row whose address lands at none of the companies person research says the
// person works at now is held from sending until the founder fixes it or
// approves that exact address.

const state = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>,
  cleared: 0,
  emailMismatch: [] as Array<boolean | undefined>,
  patches: [] as Array<{ id: number; patch: Record<string, unknown>; expect?: unknown }>,
  patchOk: true,
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
    patchLiveQueuePayload: (input: {
      id: number;
      patch: Record<string, unknown>;
      expect?: unknown;
    }) => {
      state.patches.push(input);
      return state.patchOk;
    },
  }),
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  // The real gate's contract: an ICP reject first, then the address.
  sendDraftedEmail: async (opts: {
    flags: string[];
    emailMismatch?: boolean;
    icp?: { verdict: string };
  }) => {
    state.emailMismatch.push(opts.emailMismatch);
    if (opts.icp?.verdict === "reject") opts.flags.push("off-icp");
    else if (opts.emailMismatch) opts.flags.push("email-mismatch");
    return { sent: false, receiptIds: [] };
  },
}));
vi.mock("../src/telemetry.ts", () => ({ reportServerExecution: () => {} }));
const { toView, sendDraftRoute } = await import("../src/api/queue.ts");
const { approveEmailMismatchRoute } = await import("../src/api/queue-email-mismatch.ts");

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
const mismatch = { emailDomain: "northwind.example", companies: ["Acme", "Side Project"] };
const send = () =>
  sendDraftRoute(new Request("http://localhost/api/queue/1/send-draft", { method: "POST" }), {
    id: "1",
  });
const approve = (body: unknown = { approve: true }) =>
  approveEmailMismatchRoute(
    new Request("http://localhost/api/queue/1/email-mismatch", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { id: "1" },
  );

beforeEach(() => {
  state.draft = { ...state.draft, flags: [] };
  state.payload = { email: "Jo@Northwind.example", emailMismatch: mismatch };
  state.cleared = 0;
  state.emailMismatch = [];
  state.patches = [];
  state.patchOk = true;
});

describe("email-mismatch send hold", () => {
  it("holds the row, naming the domain and the companies research found", () => {
    expect(toView(row()).sendHold).toEqual({
      code: "email-mismatch",
      reason:
        "The address is at northwind.example, but person research says they work at Acme, Side Project now. Fix the address or the company, or send to this address anyway.",
    });
  });

  it("releases it for an approval of this exact address, and holds again when the address changes", () => {
    state.payload = { ...state.payload, emailMismatchApproved: "jo@northwind.example" };
    expect(toView(row()).sendHold).toBeNull();
    state.payload = { ...state.payload, email: "jo@acme.example" };
    expect(toView(row()).sendHold?.code).toBe("email-mismatch");
  });

  it("lets a fit hold win, and holds no sent or non-email row", () => {
    expect(toView(row({ status: "sent" })).sendHold).toBeNull();
    expect(toView(row({ channel: "linkedin" })).sendHold).toBeNull();
    state.payload = { ...state.payload, icpVerdict: "reject", icpVerdictReason: "Unrelated role" };
    expect(toView(row()).sendHold).toEqual({ code: "off-icp", reason: "Unrelated role" });
  });

  it("refuses the manual send with a 409 held for the address", async () => {
    const res = await send();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      held: true,
      reason: "email-mismatch",
      error: expect.stringContaining("Regenerating the draft will not clear this hold"),
    });
    expect(state.emailMismatch).toEqual([true]);
    expect(state.cleared).toBe(1);
  });

  it("sends a draft the drain held for its address once that address is approved", async () => {
    state.draft = { ...state.draft, flags: ["email-mismatch"] } as typeof state.draft;
    state.payload = { ...state.payload, emailMismatchApproved: "jo@northwind.example" };
    const res = await send();
    // Not refused for the draft's flags: the send gate ran, without the hold.
    expect(res.status).not.toBe(400);
    expect(state.emailMismatch).toEqual([undefined]);
  });

  it("approves the exact address, guarded against a change underneath", async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    expect(state.patches).toEqual([
      {
        id: 1,
        patch: { emailMismatchApproved: "jo@northwind.example" },
        expect: [{ path: "$.email", value: "Jo@Northwind.example" }],
      },
    ]);
    state.patchOk = false;
    expect((await approve()).status).toBe(409);
  });

  it("refuses a malformed body or a row that is not held", async () => {
    expect((await approve({})).status).toBe(400);
    state.payload = { email: "jo@northwind.example" };
    expect((await approve()).status).toBe(400);
    expect(state.patches).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueRow } from "@oneshot-gtm/core";

function row(id: number, payload: Record<string, unknown> = {}): QueueRow {
  return {
    id,
    play_name: "stack-consolidation",
    payload_json: JSON.stringify({
      name: "Sam",
      email: `s${id}@x.dev`,
      company: "Acme",
      vendorStack: "playwright",
      yourEdge: "x",
      ...payload,
    }),
    dedupe_key: `k${id}`,
    source: "test",
    status: "approved",
    found_at: "now",
    reviewed_at: null,
    sent_at: null,
    notes: null,
    prospect_id: null,
    last_draft_json: null,
    last_drafted_at: null,
    send_started_at: null,
    priority_json: null,
    decision: null,
    decided_at: null,
    decided_by: null,
  };
}

const ledgerStub = {
  dequeueApproved: vi.fn<(opts: { playName: string; limit?: number }) => QueueRow[]>(),
  setQueueDraft: vi.fn(),
  setQueueStatus: vi.fn(),
  setQueueProspectId: vi.fn(),
  findProspectByEmail: vi.fn(() => null),
};

const runStackConsolidationMock = vi.fn();
const runXAmplifyDmMock = vi.fn();

vi.mock("@oneshot-gtm/core", () => ({
  getLedger: () => ledgerStub,
  isSendDeferred: (err: unknown) => err instanceof Error && err.name === "SendDeferredError",
  DEFAULT_DRAIN_ROW_RESERVATION_USD: 2,
  // Daily spend ceiling (issue #481): the drain test suite exercises drain
  // dispatch/persistence behavior, not the ceiling gate itself (that's
  // covered in daily-spend.test.ts and registry-claim.test.ts), so every
  // reservation here is granted with a no-op release by default. The
  // "downsizes the batch to headroom" test below overrides this per-call to
  // exercise the refusal + retry path.
  tryReserveDailySpend: vi.fn(() => ({ granted: true, status: {}, release: () => {} })),
}));

vi.mock("@oneshot-gtm/plays", () => {
  const PLAYS: Record<string, { run: (o: unknown) => unknown }> = {
    "stack-consolidation": { run: (opts: unknown) => runStackConsolidationMock(opts) },
    "show-hn": { run: vi.fn() },
    "job-change": { run: vi.fn() },
    "post-funding": { run: vi.fn() },
    "accelerator-batch": { run: vi.fn() },
    "hiring-signal": { run: vi.fn() },
    "podcast-guest": { run: vi.fn() },
    "competitor-switch": { run: vi.fn() },
    "breakup-revive": { run: vi.fn() },
    "x-amplify-dm": { run: (opts: unknown) => runXAmplifyDmMock(opts) },
  };
  return {
    PLAYS,
    MANUAL_PLAYS: { "x-amplify-dm": { channel: "x" } },
    isSupportedPlay: (name: string) => Object.prototype.hasOwnProperty.call(PLAYS, name),
  };
});

const { drainQueue, idsForSentDrafts } = await import("../src/drain.ts");
const { tryReserveDailySpend: tryReserveDailySpendMock } = await import("@oneshot-gtm/core");

beforeEach(() => {
  ledgerStub.dequeueApproved.mockReset();
  ledgerStub.setQueueDraft.mockReset();
  ledgerStub.setQueueStatus.mockReset();
  ledgerStub.setQueueProspectId.mockReset();
  ledgerStub.findProspectByEmail.mockReset().mockReturnValue(null);
  runStackConsolidationMock.mockReset();
  runXAmplifyDmMock.mockReset();
  vi.mocked(tryReserveDailySpendMock).mockReset();
  vi.mocked(tryReserveDailySpendMock).mockReturnValue({
    granted: true,
    status: {} as never,
    release: () => {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("idsForSentDrafts", () => {
  it("maps positionally even when middle drafts didn't send (the bug)", () => {
    const rows = [row(10), row(20), row(30)];
    const drafted = [{ sent: true }, { sent: false }, { sent: true }];
    expect(idsForSentDrafts(drafted, rows, false)).toEqual([10, 30]);
  });

  it("returns every row's id in dry-run, even when sent=false", () => {
    const rows = [row(10), row(20), row(30)];
    const drafted = [{ sent: false }, { sent: false }, { sent: false }];
    expect(idsForSentDrafts(drafted, rows, true)).toEqual([10, 20, 30]);
  });

  it("returns nothing when no draft sent and not dry-run", () => {
    const rows = [row(10), row(20)];
    const drafted = [{ sent: false }, { sent: false }];
    expect(idsForSentDrafts(drafted, rows, false)).toEqual([]);
  });

  it("ignores rows without a matching draft (defensive)", () => {
    const rows = [row(10), row(20), row(30)];
    const drafted = [{ sent: true }, { sent: true }];
    expect(idsForSentDrafts(drafted, rows, false)).toEqual([10, 20]);
  });
});

describe("drainQueue per-target dispatch + persistence", () => {
  it("setQueueDraft for every row (sent + held); setQueueStatus only on actual sends", async () => {
    ledgerStub.dequeueApproved.mockReturnValue([row(10), row(20)]);
    runStackConsolidationMock
      .mockResolvedValueOnce({
        drafted: [{ subject: "ok", body: "clean body", flags: [], sent: true, receiptIds: [101] }],
      })
      .mockResolvedValueOnce({
        drafted: [
          {
            subject: "held",
            body: "leverage robust delve",
            flags: ["ai-vocab"],
            sent: false,
            receiptIds: [],
          },
        ],
      });

    const out = await drainQueue({ playName: "stack-consolidation", dryRun: false });

    expect(out.drained).toBe(2);
    expect(out.sent).toBe(1);
    expect(out.errors).toEqual([]);

    expect(ledgerStub.setQueueDraft).toHaveBeenCalledTimes(2);
    expect(ledgerStub.setQueueDraft).toHaveBeenNthCalledWith(1, {
      id: 10,
      draft: {
        subject: "ok",
        body: "clean body",
        flags: [],
        sent: true,
        receiptIds: [101],
        dryRun: false,
      },
    });
    expect(ledgerStub.setQueueDraft).toHaveBeenNthCalledWith(2, {
      id: 20,
      draft: {
        subject: "held",
        body: "leverage robust delve",
        flags: ["ai-vocab"],
        sent: false,
        receiptIds: [],
        dryRun: false,
      },
    });
    expect(ledgerStub.setQueueStatus).toHaveBeenCalledTimes(1);
    expect(ledgerStub.setQueueStatus).toHaveBeenCalledWith({ id: 10, status: "sent" });
  });

  it("daily-cap deferral stops the batch and leaves remaining rows untouched (no draft stomp)", async () => {
    ledgerStub.dequeueApproved.mockReturnValue([row(10), row(20), row(30)]);
    const deferred = new Error("all sender identities have reached their daily cap");
    deferred.name = "SendDeferredError";
    runStackConsolidationMock
      .mockResolvedValueOnce({
        drafted: [{ subject: "ok-1", body: "b1", flags: [], sent: true, receiptIds: [1] }],
      })
      .mockRejectedValueOnce(deferred);

    const out = await drainQueue({ playName: "stack-consolidation", dryRun: false });

    expect(out.sent).toBe(1); // only row 10 shipped
    expect(out.deferred).toBe(2); // rows 20 + 30 left for tomorrow
    expect(out.errors).toEqual([]); // deferral is not an error
    // Row 20's reviewed draft was NOT overwritten with an "(error)" stub, and
    // row 30 was never dispatched (loop broke).
    expect(ledgerStub.setQueueDraft).toHaveBeenCalledTimes(1);
    expect(runStackConsolidationMock).toHaveBeenCalledTimes(2);
    expect(ledgerStub.setQueueStatus).toHaveBeenCalledTimes(1);
    expect(ledgerStub.setQueueStatus).toHaveBeenCalledWith({ id: 10, status: "sent" });
  });

  it("a throw on one target persists an error flag, the rest of the batch keeps going", async () => {
    ledgerStub.dequeueApproved.mockReturnValue([row(10), row(20), row(30)]);
    runStackConsolidationMock
      .mockResolvedValueOnce({
        drafted: [{ subject: "ok-1", body: "b1", flags: [], sent: true, receiptIds: [1] }],
      })
      .mockRejectedValueOnce(new Error("Job timed out"))
      .mockResolvedValueOnce({
        drafted: [{ subject: "ok-3", body: "b3", flags: [], sent: true, receiptIds: [3] }],
      });

    const out = await drainQueue({ playName: "stack-consolidation", dryRun: false });

    expect(out.drained).toBe(3);
    expect(out.sent).toBe(2); // rows 10 and 30
    expect(out.errors).toEqual([{ id: 20, message: "Job timed out" }]);

    expect(ledgerStub.setQueueDraft).toHaveBeenCalledTimes(3);
    expect(ledgerStub.setQueueDraft.mock.calls[1]?.[0]).toEqual({
      id: 20,
      draft: {
        subject: "(error)",
        body: "",
        flags: ["error: Job timed out"],
        sent: false,
        receiptIds: [],
        dryRun: false,
      },
    });
    expect(ledgerStub.setQueueStatus).toHaveBeenCalledTimes(2);
    expect(ledgerStub.setQueueStatus).toHaveBeenCalledWith({ id: 10, status: "sent" });
    expect(ledgerStub.setQueueStatus).toHaveBeenCalledWith({ id: 30, status: "sent" });
  });

  it("dry-run: persists drafts (dryRun:true), never flips status", async () => {
    ledgerStub.dequeueApproved.mockReturnValue([row(10), row(20)]);
    runStackConsolidationMock
      .mockResolvedValueOnce({
        drafted: [{ subject: "a", body: "a", flags: [], sent: false, receiptIds: [] }],
      })
      .mockResolvedValueOnce({
        drafted: [{ subject: "b", body: "b", flags: ["ai-vocab"], sent: false, receiptIds: [] }],
      });

    const out = await drainQueue({ playName: "stack-consolidation", dryRun: true });

    expect(out.drained).toBe(2);
    expect(out.sent).toBe(2); // would-be-sent count in dryRun
    expect(ledgerStub.setQueueDraft).toHaveBeenCalledTimes(2);
    expect(ledgerStub.setQueueDraft.mock.calls[0]?.[0]).toMatchObject({ draft: { dryRun: true } });
    expect(ledgerStub.setQueueStatus).not.toHaveBeenCalled();
  });

  it("an unsupported play fails the drain up-front (the only global precondition left)", async () => {
    // No play needs drain-level options any more — every finder row is
    // self-contained — so the only up-front failure is an unknown play.
    ledgerStub.dequeueApproved.mockReturnValue([row(10)]);
    const out = await drainQueue({ playName: "no-such-play", dryRun: false });
    expect(out.errors[0]?.id).toBe(-1);
    expect(out.errors[0]?.message).toMatch(/unsupported/);
    expect(ledgerStub.setQueueDraft).not.toHaveBeenCalled();
  });

  it("downsizes the batch to headroom instead of refusing outright (issue #481 finding)", async () => {
    // $10 ceiling, $0 spent, 10 rows at $2/row = a $20 ask that the ceiling
    // refuses outright. remainingUsd=10 means 4 rows ($8) fit under the
    // strict `<` reservation check (5 rows = $10 would land AT the ceiling).
    const rows = Array.from({ length: 10 }, (_, i) => row((i + 1) * 10));
    ledgerStub.dequeueApproved.mockReturnValue(rows);
    vi.mocked(tryReserveDailySpendMock)
      .mockReturnValueOnce({
        granted: false,
        reason: "daily spend ceiling reached ($0.00/$10.00 spent or reserved today)",
        status: { remainingUsd: 10 } as never,
      })
      .mockReturnValueOnce({ granted: true, status: {} as never, release: () => {} });
    runStackConsolidationMock.mockResolvedValue({
      drafted: [{ subject: "ok", body: "b", flags: [], sent: true, receiptIds: [1] }],
    });

    const out = await drainQueue({ playName: "stack-consolidation", dryRun: false });

    // Only the affordable 4 rows were dispatched, not zero.
    expect(out.drained).toBe(4);
    expect(runStackConsolidationMock).toHaveBeenCalledTimes(4);
    expect(out.haltedReason).toBeUndefined();
    // Second reservation call asked for the downsized batch's cost (4 * $2 = $8).
    expect(tryReserveDailySpendMock).toHaveBeenCalledTimes(2);
    expect(tryReserveDailySpendMock).toHaveBeenNthCalledWith(1, 10 * 2);
    expect(tryReserveDailySpendMock).toHaveBeenNthCalledWith(2, 4 * 2);
  });

  it("still refuses outright when even the downsized batch doesn't fit (no headroom)", async () => {
    ledgerStub.dequeueApproved.mockReturnValue([row(10), row(20)]);
    vi.mocked(tryReserveDailySpendMock).mockReturnValue({
      granted: false,
      reason: "daily spend ceiling reached ($10.00/$10.00 spent or reserved today)",
      status: { remainingUsd: 0 } as never,
    });

    const out = await drainQueue({ playName: "stack-consolidation", dryRun: false });

    expect(out.drained).toBe(0);
    expect(out.haltedReason).toContain("daily spend ceiling reached");
    expect(runStackConsolidationMock).not.toHaveBeenCalled();
    // No retry attempted — affordableRows was 0.
    expect(tryReserveDailySpendMock).toHaveBeenCalledTimes(1);
  });

  it("manual-play rows with a clean draft are left alone — no re-draft, no stomp", async () => {
    // x-amplify-dm rows stay approved until the founder hand-sends, so the
    // drain lease re-claims them every cycle. Once drafted, they must not be
    // dispatched again: that would pay the LLM twice and overwrite a draft the
    // founder may have already copied.
    const drafted = { ...row(10), play_name: "x-amplify-dm" };
    drafted.last_draft_json = JSON.stringify({ subject: "X DM → @a", body: "dm text", flags: [] });
    ledgerStub.dequeueApproved.mockReturnValue([drafted]);
    const out = await drainQueue({ playName: "x-amplify-dm", dryRun: false });
    expect(runXAmplifyDmMock).not.toHaveBeenCalled();
    expect(ledgerStub.setQueueDraft).not.toHaveBeenCalled();
    expect(out.sent).toBe(0);
  });

  it("manual-play rows without a draft (or with an errored one) still get drafted, never sent", async () => {
    runXAmplifyDmMock.mockResolvedValue({
      drafted: [{ subject: "X DM → @a", body: "dm text", flags: [], sent: false, receiptIds: [] }],
    });
    const errored = { ...row(20), play_name: "x-amplify-dm" };
    errored.last_draft_json = JSON.stringify({
      subject: "(error)",
      body: "",
      flags: ["error: provider down"],
    });
    ledgerStub.dequeueApproved.mockReturnValue([
      { ...row(10), play_name: "x-amplify-dm" },
      errored,
    ]);
    const out = await drainQueue({ playName: "x-amplify-dm", dryRun: false });
    expect(runXAmplifyDmMock).toHaveBeenCalledTimes(2);
    expect(ledgerStub.setQueueDraft).toHaveBeenCalledTimes(2);
    // sent:false drafts leave the rows approved for the hand-send flow.
    expect(ledgerStub.setQueueStatus).not.toHaveBeenCalled();
    expect(out.sent).toBe(0);
  });
});

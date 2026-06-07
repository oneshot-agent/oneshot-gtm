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

vi.mock("@oneshot-gtm/core", () => ({
  getLedger: () => ledgerStub,
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
  };
  return {
    PLAYS,
    isSupportedPlay: (name: string) => Object.prototype.hasOwnProperty.call(PLAYS, name),
  };
});

const { drainQueue, idsForSentDrafts } = await import("../src/drain.ts");

beforeEach(() => {
  ledgerStub.dequeueApproved.mockReset();
  ledgerStub.setQueueDraft.mockReset();
  ledgerStub.setQueueStatus.mockReset();
  ledgerStub.setQueueProspectId.mockReset();
  ledgerStub.findProspectByEmail.mockReset().mockReturnValue(null);
  runStackConsolidationMock.mockReset();
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
    // accelerator-batch no longer needs a drain-level senderCohort — it rides on
    // the row now — so the only up-front failure is an unknown play.
    ledgerStub.dequeueApproved.mockReturnValue([row(10)]);
    const out = await drainQueue({ playName: "no-such-play", dryRun: false });
    expect(out.errors[0]?.id).toBe(-1);
    expect(out.errors[0]?.message).toMatch(/unsupported/);
    expect(ledgerStub.setQueueDraft).not.toHaveBeenCalled();
  });
});

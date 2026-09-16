import { describe, expect, it, vi } from "vitest";
import type { CadenceView } from "@oneshot-gtm/shared-types";
import {
  cadenceKey,
  cadenceSelection,
  stopCadences,
  type CadenceStopTarget,
} from "../src/lib/cadenceStop.ts";

const target = (prospectId: number, playName = "repo-interest"): CadenceStopTarget => ({
  prospectId,
  playName,
  prospectName: `Person ${prospectId}`,
});
const row = (id: number, overrides: Partial<CadenceView> = {}): CadenceView =>
  ({
    ...target(id),
    status: "active",
    isSending: false,
    nextStepChannel: "email",
    nextStepLabel: "follow-up",
    nextStepDraft: { subject: "hello", body: "body", flags: [], draftedAt: "2026-09-14T00:00:00Z" },
    ...overrides,
  }) as CadenceView;

describe("cadenceSelection", () => {
  it("allows stopping selected mail and no-draft cadences without including them in email sends", () => {
    const rows = [
      row(1),
      row(2, { nextStepChannel: "direct_mail" }),
      row(3, { nextStepDraft: null }),
      row(4, { isSending: true }),
      row(5, { status: "stopped" }),
      row(6, { nextStepLabel: null, nextStepDraft: null }),
    ];
    const result = cadenceSelection(rows, new Set(rows.map(cadenceKey)));
    expect(result.selectable.map((c) => c.prospectId)).toEqual([1, 2, 3, 6]);
    expect(result.stoppable.map((c) => c.prospectId)).toEqual([1, 2, 3, 6]);
    expect(result.previewable.map((c) => c.prospectId)).toEqual([1, 3]);
    expect(result.sendable.map((c) => c.prospectId)).toEqual([1]);
  });
  it("does not include hidden or unselected cadences or send flagged drafts", () => {
    const rows = [
      row(1),
      row(2, {
        nextStepDraft: {
          subject: "hi",
          body: "body",
          flags: ["em-dash"],
          draftedAt: "2026-09-14T00:00:00Z",
        },
      }),
    ];
    const result = cadenceSelection(rows, new Set([cadenceKey(rows[1]!), "99|other"]));
    expect(result.chosen).toEqual([rows[1]]);
    expect(result.sendable).toEqual([]);
  });
});

describe("stopCadences", () => {
  it("applies the same reason and note, deduplicating by prospect AND play", async () => {
    const stop = vi.fn().mockResolvedValue({ stopped: 1 });
    const input = { reason: "not_a_fit" as const, note: "wrong industry; not the buyer" };
    const items = [target(1), target(1, "other-play"), target(1)];
    const result = await stopCadences(items, input, stop);
    expect(stop.mock.calls).toEqual([
      [1, "repo-interest", input],
      [1, "other-play", input],
    ]);
    expect(result.stopped).toEqual(items.slice(0, 2));
    expect(result.failed).toEqual([]);
  });
  it("continues after individual errors and retries only failed rows", async () => {
    const stop = vi
      .fn()
      .mockResolvedValueOnce({ stopped: 1 })
      .mockRejectedValueOnce(new Error("send is in flight"))
      .mockResolvedValueOnce({ stopped: 1 });
    const input = { reason: "bad_timing" as const };
    const result = await stopCadences([target(1), target(2), target(3)], input, stop);
    expect(result.stopped).toEqual([target(1), target(3)]);
    expect(result.failed).toEqual([{ target: target(2), message: "send is in flight" }]);
    const retry = vi.fn().mockResolvedValue({ stopped: 1 });
    await stopCadences(
      result.failed.map((f) => f.target),
      input,
      retry,
    );
    expect(retry.mock.calls).toEqual([[2, "repo-interest", input]]);
  });
  it("does not claim success when the endpoint reports no stop", async () => {
    const result = await stopCadences(
      [target(1)],
      { reason: "other", note: "manual review" },
      vi.fn().mockResolvedValue({ stopped: 0 }),
    );
    expect(result.stopped).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });
});

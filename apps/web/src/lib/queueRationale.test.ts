import { describe, expect, it } from "vitest";
import { movedProvenance, movedRejectReason } from "./queueRationale.ts";

const movedFrom = { workspace: "other", queueId: 3, at: "2026-10-05T00:00:00Z" };

describe("movedProvenance", () => {
  it("is null for a row that was not moved", () => {
    expect(movedProvenance({ yourEdge: "x" })).toBeNull();
    expect(movedProvenance(null)).toBeNull();
  });

  it("names where the edge here came from", () => {
    expect(movedProvenance({ movedFrom, yourEdgeSource: "destination-trigger:list-page" })).toBe(
      "moved from other · edge from this workspace's list-page trigger",
    );
    expect(movedProvenance({ movedFrom, yourEdgeSource: "generated-on-move" })).toBe(
      "moved from other · edge generated for this workspace",
    );
    expect(movedProvenance({ movedFrom, yourEdgeSource: "none" })).toBe(
      "moved from other · no edge here (add product positioning in Setup)",
    );
    expect(movedProvenance({ movedFrom })).toBe("moved from other · edge not derived yet");
  });
});

describe("movedRejectReason", () => {
  it("shows the reject reason only on a moved row", () => {
    expect(
      movedRejectReason({ movedFrom, icpVerdict: "reject", icpVerdictReason: "student" }),
    ).toBe("student");
    expect(movedRejectReason({ movedFrom, icpVerdict: "reject" })).toBe("does not fit this ICP");
    expect(movedRejectReason({ movedFrom, icpVerdict: "pass" })).toBeNull();
    expect(movedRejectReason({ icpVerdict: "reject", icpVerdictReason: "x" })).toBeNull();
  });
});

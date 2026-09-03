import { describe, expect, it } from "vitest";
import { humanDecisionWhereSql, isHumanApproval, isHumanDecision } from "../src/labels.ts";
import type { QueueRow } from "../src/types.ts";

const at = "2026-09-01T12:00:00.000Z";

type LabelRow = Pick<QueueRow, "status" | "notes" | "reviewed_at" | "decision" | "decided_by">;

/** Legacy-shaped row: NULL provenance → predicates fall back to status inference. */
function legacy(input: Partial<LabelRow>): LabelRow {
  return {
    status: "pending",
    notes: null,
    reviewed_at: null,
    decision: null,
    decided_by: null,
    ...input,
  } as LabelRow;
}

describe("isHumanDecision — provenance-first (v26)", () => {
  it("trusts the decision columns when present, regardless of current status", () => {
    // The Phase 3 point: an approved row machinery later expired keeps its label.
    expect(
      isHumanDecision(
        legacy({ status: "expired", decision: "approve", decided_by: "human", reviewed_at: at }),
      ),
    ).toBe(true);
    expect(
      isHumanDecision(legacy({ status: "rejected", decision: "reject", decided_by: "human" })),
    ).toBe(true);
  });

  it("bulk approvals count as human; machine decisions never do", () => {
    expect(
      isHumanDecision(
        legacy({ status: "approved", decision: "approve", decided_by: "human_bulk" }),
      ),
    ).toBe(true);
    expect(
      isHumanDecision(
        legacy({ status: "rejected", decision: "auto_reject", decided_by: "machine" }),
      ),
    ).toBe(false);
    // A machine-stamped approve (send on a never-decided row) is not a human label.
    expect(
      isHumanDecision(legacy({ status: "sent", decision: "approve", decided_by: "machine" })),
    ).toBe(false);
  });

  it("falls back to status inference for NULL-provenance rows", () => {
    expect(isHumanDecision(legacy({ status: "approved", reviewed_at: at }))).toBe(true);
    expect(isHumanDecision(legacy({ status: "sent", reviewed_at: at }))).toBe(true);
    expect(
      isHumanDecision(legacy({ status: "rejected", notes: "wrong segment", reviewed_at: at })),
    ).toBe(true);
    expect(
      isHumanDecision(legacy({ status: "rejected", notes: "auto: ICP — no", reviewed_at: at })),
    ).toBe(false);
    expect(isHumanDecision(legacy({ status: "approved", reviewed_at: null }))).toBe(false);
    expect(isHumanDecision(legacy({ status: "pending", reviewed_at: at }))).toBe(false);
    // Expiry machinery stamps reviewed_at without judgment.
    expect(isHumanDecision(legacy({ status: "expired", reviewed_at: at }))).toBe(false);
  });
});

describe("isHumanApproval", () => {
  it("is the positive subset in both provenance and fallback modes", () => {
    expect(
      isHumanApproval(legacy({ status: "expired", decision: "approve", decided_by: "human" })),
    ).toBe(true);
    expect(
      isHumanApproval(legacy({ status: "rejected", decision: "reject", decided_by: "human" })),
    ).toBe(false);
    expect(isHumanApproval(legacy({ status: "sent", reviewed_at: at }))).toBe(true);
    expect(isHumanApproval(legacy({ status: "rejected", notes: "no", reviewed_at: at }))).toBe(
      false,
    );
    expect(isHumanApproval(legacy({ status: "approved", reviewed_at: null }))).toBe(false);
  });
});

describe("humanDecisionWhereSql", () => {
  it("prefixes every column reference for aliased queries", () => {
    const sql = humanDecisionWhereSql("q.");
    for (const col of ["q.decision", "q.decided_by", "q.reviewed_at", "q.status", "q.notes"]) {
      expect(sql).toContain(col);
    }
    expect(humanDecisionWhereSql()).not.toContain("q.");
  });

  it("guards the legacy arm with decision IS NULL and keeps the 3VL COALESCE", () => {
    const sql = humanDecisionWhereSql();
    expect(sql).toContain("decision IS NULL");
    expect(sql).toContain("COALESCE(notes, '')");
  });
});

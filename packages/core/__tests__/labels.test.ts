import { describe, expect, it } from "vitest";
import { humanDecisionWhereSql, isHumanApproval, isHumanDecision } from "../src/labels.ts";

const at = "2026-09-01T12:00:00.000Z";

describe("isHumanDecision — the shared label predicate", () => {
  it("accepts human approve / send / reject", () => {
    expect(isHumanDecision({ status: "approved", notes: null, reviewed_at: at })).toBe(true);
    expect(isHumanDecision({ status: "sent", notes: null, reviewed_at: at })).toBe(true);
    expect(isHumanDecision({ status: "rejected", notes: "wrong segment", reviewed_at: at })).toBe(
      true,
    );
  });

  it("rejects machine rejections, unreviewed rows, and expiry-machinery stamps", () => {
    expect(isHumanDecision({ status: "rejected", notes: "auto: ICP — no", reviewed_at: at })).toBe(
      false,
    );
    expect(isHumanDecision({ status: "approved", notes: null, reviewed_at: null })).toBe(false);
    expect(isHumanDecision({ status: "pending", notes: null, reviewed_at: at })).toBe(false);
    // Expired rows get reviewed_at from reservations/bulk stamps/cadence
    // stops, never from a per-row judgment.
    expect(isHumanDecision({ status: "expired", notes: null, reviewed_at: at })).toBe(false);
  });
});

describe("isHumanApproval", () => {
  it("is the positive subset of human decisions", () => {
    expect(isHumanApproval({ status: "sent", notes: null, reviewed_at: at })).toBe(true);
    expect(isHumanApproval({ status: "rejected", notes: "no", reviewed_at: at })).toBe(false);
    expect(isHumanApproval({ status: "approved", notes: null, reviewed_at: null })).toBe(false);
  });
});

describe("humanDecisionWhereSql", () => {
  it("prefixes every column reference for aliased queries", () => {
    const sql = humanDecisionWhereSql("q.");
    expect(sql).toContain("q.reviewed_at");
    expect(sql).toContain("q.status IN");
    expect(sql).toContain("COALESCE(q.notes, '') LIKE 'auto:%'");
    // Unprefixed form has no stray column-qualifying dots.
    expect(humanDecisionWhereSql()).not.toContain("q.");
  });

  it("NULL notes never hides a human rejection (three-valued logic guard)", () => {
    // The COALESCE is load-bearing: `NULL LIKE 'auto:%'` is NULL and
    // `NOT (… AND NULL)` filters the row out.
    expect(humanDecisionWhereSql()).toContain("COALESCE(notes, '')");
  });
});

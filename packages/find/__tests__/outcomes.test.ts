import { describe, expect, it } from "vitest";
import type { SentOutcomeRawRow } from "@oneshot-gtm/core";
import {
  OUTCOME_MATURITY_DAYS,
  buildOutcomeReport,
  labelSentRow,
  maxOutcomeRank,
  valueTagToRank,
} from "../src/_outcomes.ts";

const NOW = new Date("2026-09-02T12:00:00Z");

function raw(overrides: Partial<SentOutcomeRawRow> = {}): SentOutcomeRawRow {
  return {
    id: 1,
    play_name: "post-funding",
    dedupe_key: "k1",
    priority_json: null,
    sent_at: "2026-08-01 10:00:00", // ~32 days before NOW — mature
    decision: "approve",
    decided_by: "human",
    joined_prospect_id: 7,
    payload_email: "ada@acme.dev",
    first_email_reply_at: null,
    first_channel_reply_at: null,
    deal_rank: null,
    ...overrides,
  };
}

function artifact(total: number): string {
  return JSON.stringify({
    version: "heuristic-v2",
    total,
    components: {
      personFit: total,
      accountFit: total,
      intentStrength: total,
      timingFreshness: total,
      signalConfidence: total,
      contactability: total,
    },
    reasons: [],
    finder: "t",
    scoredAt: "2026-08-01T10:00:00.000Z",
  });
}

describe("labelSentRow", () => {
  it("merges outcome evidence by max rank", () => {
    expect(labelSentRow(raw({ first_email_reply_at: "x" }), "none", NOW).outcome).toBe("reply");
    expect(labelSentRow(raw({ first_channel_reply_at: "x" }), "none", NOW).outcome).toBe("reply");
    expect(labelSentRow(raw({ deal_rank: 2 }), "none", NOW).outcome).toBe("meeting");
    expect(
      labelSentRow(raw({ first_email_reply_at: "x", deal_rank: 4 }), "none", NOW).outcome,
    ).toBe("revenue");
    expect(labelSentRow(raw(), "qualified", NOW).outcome).toBe("qualified");
  });

  it("maturity boundary: 14 days flips no-outcome rows from immature to negative", () => {
    const justUnder = new Date(NOW.getTime() - (OUTCOME_MATURITY_DAYS - 0.1) * 86400000);
    const justOver = new Date(NOW.getTime() - (OUTCOME_MATURITY_DAYS + 0.1) * 86400000);
    const under = labelSentRow(raw({ sent_at: justUnder.toISOString() }), "none", NOW);
    const over = labelSentRow(raw({ sent_at: justOver.toISOString() }), "none", NOW);
    expect(under.label).toBe("immature");
    expect(over.label).toBe("negative");
  });

  it("unjoinable rows are excluded, never negatives; positives don't need maturity", () => {
    expect(labelSentRow(raw({ joined_prospect_id: null }), "none", NOW).label).toBe("unjoinable");
    const fresh = labelSentRow(
      raw({ sent_at: NOW.toISOString(), first_email_reply_at: "x" }),
      "none",
      NOW,
    );
    expect(fresh.label).toBe("positive");
  });

  it("is deterministic and normalizes SQLite's zone-less sent_at", () => {
    const a = labelSentRow(raw(), "none", NOW);
    const b = labelSentRow(raw(), "none", NOW);
    expect(b).toEqual(a);
    expect(a.daysSinceSend).toBeGreaterThan(31);
    expect(a.daysSinceSend).toBeLessThan(33);
  });
});

describe("valueTagToRank / maxOutcomeRank", () => {
  it("maps the receipts ladder and survives junk", () => {
    expect(valueTagToRank('{"type":"engagement"}')).toBe("reply");
    expect(valueTagToRank('{"type":"revenue","amount":500}')).toBe("revenue");
    expect(valueTagToRank('{"type":"unknown"}')).toBe("none");
    expect(valueTagToRank("{broken")).toBe("none");
    expect(maxOutcomeRank("reply", "meeting")).toBe("meeting");
    expect(maxOutcomeRank("revenue", "none")).toBe("revenue");
  });
});

describe("buildOutcomeReport", () => {
  it("rates over mature rows only, buckets scored rows, AUC over pos vs mature neg", () => {
    const labels = [
      labelSentRow(
        raw({ id: 1, priority_json: artifact(70), first_email_reply_at: "x" }),
        "none",
        NOW,
      ),
      labelSentRow(raw({ id: 2, priority_json: artifact(65) }), "none", NOW), // mature negative
      labelSentRow(raw({ id: 3, priority_json: artifact(40) }), "none", NOW), // mature negative
      labelSentRow(raw({ id: 4, sent_at: NOW.toISOString() }), "none", NOW), // immature
      labelSentRow(raw({ id: 5, joined_prospect_id: null }), "none", NOW), // unjoinable
    ];
    const [report] = buildOutcomeReport(labels);
    expect(report!.sends).toBe(5);
    expect(report!.mature).toBe(3);
    expect(report!.immature).toBe(1);
    expect(report!.unjoinable).toBe(1);
    expect(report!.replies).toBe(1);
    expect(report!.replyRate!.rate).toBeCloseTo(1 / 3);
    expect(report!.repliesByBucket["60-79"]).toEqual({ n: 2, replied: 1 });
    expect(report!.repliesByBucket["40-59"]).toEqual({ n: 1, replied: 0 });
    // 70 vs [65, 40] → replier outranks both.
    expect(report!.scoreVsOutcomeAuc).toBe(1);
  });
});

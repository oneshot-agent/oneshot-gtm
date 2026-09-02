import type { ProspectPriorityComponents, SentOutcomeRawRow } from "@oneshot-gtm/core";
import { parseProspectPriority } from "@oneshot-gtm/core";
import { mannWhitneyAuc, meanOf, wilson95 } from "./_gauge.ts";
import { SCORE_BUCKETS, bucketOf } from "./_buckets.ts";

/**
 * Outcome labeling for sent queue rows (Phase 3 of #410). Pure — injected
 * clock, no I/O; labels are recomputed on every read, never frozen, so a
 * late reply flips its row to positive on the next run.
 */

export type OutcomeRank = "none" | "reply" | "meeting" | "qualified" | "revenue";

const RANK_ORDER: OutcomeRank[] = ["none", "reply", "meeting", "qualified", "revenue"];

/**
 * How long a joinable sent row must go without any outcome before it counts
 * as a negative. The cadence engine's last non-breakup touch lands inside
 * two weeks, and cold-email replies arrive within days of a touch — 14 days
 * balances label latency against false negatives.
 */
export const OUTCOME_MATURITY_DAYS = 14;

/**
 * Mirrors the monotone value-tag ladder in core/oneshot.ts (`valueTagRank`:
 * engagement 1 < meeting 2 < qualified 3 < revenue 4). Restated locally as a
 * display/label ladder — if a tag type is ever added there, add it here.
 */
const VALUE_TAG_TO_RANK: Record<string, OutcomeRank> = {
  engagement: "reply",
  meeting: "meeting",
  qualified: "qualified",
  revenue: "revenue",
};

const DEAL_RANK_TO_OUTCOME: Record<number, OutcomeRank> = {
  2: "meeting",
  3: "qualified",
  4: "revenue",
};

export interface SentOutcomeLabel {
  id: number;
  finder: string;
  priorityTotal: number | null;
  components: ProspectPriorityComponents | null;
  joinable: boolean;
  daysSinceSend: number;
  outcome: OutcomeRank;
  /**
   * positive = any outcome; negative = joinable, mature, none;
   * immature = too recent to judge; unjoinable = no prospect link.
   * Only positive/negative ever enter a denominator.
   */
  label: "positive" | "negative" | "immature" | "unjoinable";
}

const DAY_MS = 24 * 60 * 60 * 1000;

function maxRank(...ranks: OutcomeRank[]): OutcomeRank {
  return ranks.reduce((a, b) => (RANK_ORDER.indexOf(b) > RANK_ORDER.indexOf(a) ? b : a), "none");
}

/** Exported for callers folding multiple receipts into one per-goal rank. */
export function maxOutcomeRank(a: OutcomeRank, b: OutcomeRank): OutcomeRank {
  return maxRank(a, b);
}

/**
 * Label one sent row. `receiptRankByGoal` maps goal_id → OutcomeRank from
 * the receipts value-tag ladder (the caller computes goal ids with
 * `cadenceGoalId(play, email)`, mirroring the `pid:` fallback used by
 * tagOutcomeValue when the payload has no email).
 */
export function labelSentRow(
  raw: SentOutcomeRawRow,
  receiptRank: OutcomeRank,
  now: Date,
): SentOutcomeLabel {
  const priority = parseProspectPriority(raw.priority_json);
  const sentAtIso = /^\d{4}-\d{2}-\d{2} /.test(raw.sent_at)
    ? `${raw.sent_at.replace(" ", "T")}Z`
    : raw.sent_at;
  const sentMs = Date.parse(sentAtIso);
  const daysSinceSend = Number.isFinite(sentMs) ? (now.getTime() - sentMs) / DAY_MS : 0;
  const joinable = raw.joined_prospect_id !== null;

  const replied = raw.first_email_reply_at !== null || raw.first_channel_reply_at !== null;
  const outcome = maxRank(
    replied ? "reply" : "none",
    raw.deal_rank !== null ? (DEAL_RANK_TO_OUTCOME[raw.deal_rank] ?? "none") : "none",
    receiptRank,
  );

  let label: SentOutcomeLabel["label"];
  if (!joinable) label = "unjoinable";
  else if (outcome !== "none") label = "positive";
  else if (daysSinceSend >= OUTCOME_MATURITY_DAYS) label = "negative";
  else label = "immature";

  return {
    id: raw.id,
    finder: raw.play_name,
    priorityTotal: priority?.total ?? null,
    components: priority?.components ?? null,
    joinable,
    daysSinceSend,
    outcome,
    label,
  };
}

/** Parse a receipts value_tag JSON into its ladder rank. */
export function valueTagToRank(valueTagJson: string): OutcomeRank {
  try {
    const parsed = JSON.parse(valueTagJson) as { type?: unknown };
    return typeof parsed.type === "string" ? (VALUE_TAG_TO_RANK[parsed.type] ?? "none") : "none";
  } catch {
    return "none";
  }
}

export interface FinderOutcomeReport {
  finder: string;
  sends: number;
  unjoinable: number;
  immature: number;
  /** positives + negatives — the only rows rates are computed over. */
  mature: number;
  replies: number;
  replyRate: { rate: number; lo: number; hi: number } | null;
  meetingsPlus: number;
  /** Reply counts per v2 score bucket, over mature scored rows. */
  repliesByBucket: Record<(typeof SCORE_BUCKETS)[number], { n: number; replied: number }>;
  /** P(random replier outranks a random mature non-replier) by stored score. */
  scoreVsOutcomeAuc: number | null;
}

export function buildOutcomeReport(labels: SentOutcomeLabel[]): FinderOutcomeReport[] {
  const byFinder = new Map<string, SentOutcomeLabel[]>();
  for (const label of labels) {
    byFinder.set(label.finder, [...(byFinder.get(label.finder) ?? []), label]);
  }
  return [...byFinder.entries()]
    .map(([finder, rows]): FinderOutcomeReport => {
      const mature = rows.filter((r) => r.label === "positive" || r.label === "negative");
      const positives = mature.filter((r) => r.label === "positive");
      const replies = positives.length;
      const repliesByBucket = Object.fromEntries(
        SCORE_BUCKETS.map((b) => [b, { n: 0, replied: 0 }]),
      ) as FinderOutcomeReport["repliesByBucket"];
      for (const row of mature) {
        if (row.priorityTotal === null) continue;
        const bucket = repliesByBucket[bucketOf(row.priorityTotal)];
        bucket.n++;
        if (row.label === "positive") bucket.replied++;
      }
      const posScores = positives
        .map((r) => r.priorityTotal)
        .filter((t): t is number => t !== null);
      const negScores = mature
        .filter((r) => r.label === "negative")
        .map((r) => r.priorityTotal)
        .filter((t): t is number => t !== null);
      return {
        finder,
        sends: rows.length,
        unjoinable: rows.filter((r) => r.label === "unjoinable").length,
        immature: rows.filter((r) => r.label === "immature").length,
        mature: mature.length,
        replies,
        replyRate:
          mature.length > 0
            ? { rate: replies / mature.length, ...wilson95(replies, mature.length) }
            : null,
        meetingsPlus: rows.filter(
          (r) => r.outcome === "meeting" || r.outcome === "qualified" || r.outcome === "revenue",
        ).length,
        repliesByBucket,
        scoreVsOutcomeAuc: mannWhitneyAuc(posScores, negScores),
      };
    })
    .toSorted((a, b) => a.finder.localeCompare(b.finder));
}

/** Mean days-to-reply among positives with a parsable send time — report color. */
export function meanDaysToReply(labels: SentOutcomeLabel[]): number | null {
  return meanOf(labels.filter((l) => l.label === "positive").map((l) => l.daysSinceSend));
}

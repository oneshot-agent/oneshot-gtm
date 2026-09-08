import type {
  ChannelEventRecord,
  DealOutcomeRecord,
  InboxReplyRecord,
  QueueRow,
  SequenceEventRecord,
} from "@oneshot-gtm/core";
import { describeDecision, type ProspectTimelineEvent } from "@oneshot-gtm/shared-types";

/**
 * sequence_events.created_at, deal_outcomes.recorded_at and target_queue's
 * found_at use SQLite datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC, no
 * 'T'/'Z'); reply and decision timestamps are ISO. Normalise so the merged
 * string sort is chronological. Same rule as inbox.ts, kept local so this
 * pure module does not drag the Gmail-backed inbox route into its tests.
 */
function sqliteToIso(ts: string): string {
  return ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
}

/**
 * The history behind one /prospects row, newest first: the queue row's own
 * milestones (surfaced, decided, sent) merged with everything recorded
 * against the prospect it resolved to. Pure — the route gathers the rows,
 * this orders and labels them.
 *
 * No reply bodies on purpose. The drawer is a browse surface and the body is
 * the one field a screenshot cannot mask; /inbox owns the conversation.
 */
export function buildProspectTimeline(input: {
  row: Pick<
    QueueRow,
    "play_name" | "found_at" | "decided_at" | "decided_by" | "decision" | "notes" | "sent_at"
  >;
  sequenceEvents: ReadonlyArray<SequenceEventRecord>;
  replies: ReadonlyArray<InboxReplyRecord>;
  channelEvents: ReadonlyArray<ChannelEventRecord>;
  outcomes: ReadonlyArray<DealOutcomeRecord>;
}): ProspectTimelineEvent[] {
  const { row } = input;
  const events: ProspectTimelineEvent[] = [];

  events.push({
    at: sqliteToIso(row.found_at),
    kind: "surfaced",
    label: "surfaced",
    detail: null,
    playName: row.play_name,
  });
  if (row.decided_at) {
    events.push({
      at: sqliteToIso(row.decided_at),
      kind: "decided",
      label: describeDecision({ decision: row.decision, decidedBy: row.decided_by }),
      detail: row.notes,
      playName: row.play_name,
    });
  }
  if (row.sent_at) {
    events.push({
      at: sqliteToIso(row.sent_at),
      kind: "sent",
      label: "sent",
      detail: null,
      playName: row.play_name,
    });
  }

  for (const ev of input.sequenceEvents) {
    const meta = parseMeta(ev.metadata_json);
    const step = typeof meta["label"] === "string" ? meta["label"] : `step ${ev.step_index + 1}`;
    const status = ev.status === "sent" || ev.status === "delivered" ? "" : ` · ${ev.status}`;
    events.push({
      at: sqliteToIso(ev.created_at),
      kind: "sequence",
      label: `${ev.channel} ${step}${status}`,
      detail: typeof meta["subject"] === "string" ? meta["subject"] : null,
      playName: ev.play_name,
    });
  }

  for (const r of input.replies) {
    // NULL kind predates the classifier and reads as human everywhere.
    const kind = r.kind ?? "human";
    const label =
      kind === "human"
        ? r.intent
          ? `reply · ${r.intent}`
          : "reply"
        : kind === "unsubscribe"
          ? "unsubscribed"
          : kind === "auto_permanent"
            ? "mailbox gone"
            : "auto-reply";
    events.push({
      at: sqliteToIso(r.received_at),
      kind: "reply",
      label,
      detail: r.subject,
      playName: r.play_name,
    });
  }

  for (const ce of input.channelEvents) {
    events.push({
      at: sqliteToIso(ce.occurred_at),
      kind: "channel",
      label: `${ce.channel} ${ce.event_type}`,
      detail: null,
      playName: null,
    });
  }

  for (const o of input.outcomes) {
    const amount =
      typeof o.amount_usd === "number" && o.amount_usd > 0
        ? ` · $${Math.round(o.amount_usd).toLocaleString("en-US")}`
        : "";
    events.push({
      at: sqliteToIso(o.recorded_at),
      kind: "outcome",
      label: `${o.outcome.replace(/_/g, " ")}${amount}`,
      detail: o.notes,
      playName: o.play_name,
    });
  }

  // Newest first. Compare as instants, not strings: "…:34Z" and "…:34.443Z"
  // are the same second but sort the wrong way round lexically. Ties keep
  // insertion order reversed so a same-instant milestone reads sensibly.
  const instant = (e: ProspectTimelineEvent): number => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) ? t : 0;
  };
  return events
    .map((e, i) => ({ e, i, t: instant(e) }))
    .toSorted((a, b) => b.t - a.t || b.i - a.i)
    .map(({ e }) => e);
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

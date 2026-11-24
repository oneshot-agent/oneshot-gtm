import { sqliteToIso } from "@oneshot-gtm/core/time";
import type {
  ChannelEventRecord,
  DealOutcomeRecord,
  InboxReplyRecord,
  QueueRow,
  SequenceEventRecord,
} from "@oneshot-gtm/core";
import {
  CALL_OUTCOMES,
  describeDecision,
  replyIntentMeta,
  type CallRecordView,
  type ProspectTimelineEvent,
  type SendDeliveryView,
} from "@oneshot-gtm/shared-types";

/** "reply · not now", from the shared label table; unknown labels pass through raw. */
function replyLabel(intent: string, review: boolean): string {
  const title = replyIntentMeta(intent)?.title.toLowerCase() ?? intent;
  return `reply · ${title}${review ? " (check label)" : ""}`;
}

type TimelineChannel = NonNullable<ProspectTimelineEvent["channel"]>;

/** The pane's four channels; a step or event on any other (x, direct mail) has none. */
function touchChannel(raw: string): TimelineChannel | null {
  if (raw === "email" || raw === "sms" || raw === "call") return raw;
  if (raw === "voice") return "call";
  if (raw.startsWith("linkedin")) return "linkedin";
  return null;
}

function callLabel(outcome: CallRecordView["outcome"]): string {
  const title = CALL_OUTCOMES.find((o) => o.outcome === outcome)?.title.toLowerCase();
  return `call · ${title ?? "not logged"}`;
}

export type TimelineQueueRow = Pick<
  QueueRow,
  | "play_name"
  | "found_at"
  | "decided_at"
  | "decided_by"
  | "decided_by_member"
  | "decision"
  | "notes"
  | "sent_at"
>;

/**
 * A prospect's history, newest first: each queue row's own milestones
 * (surfaced, decided, sent) merged with everything recorded against the
 * prospect. Pure. The route gathers the rows, this orders and labels them.
 *
 * Bodies only with `withBodies`, which only GET /api/person sets: the
 * /prospects drawer stays a browse surface, and the person pane renders no
 * body in privacy mode, since a body is the one field a screenshot cannot mask.
 */
export function buildProspectTimeline(input: {
  rows: ReadonlyArray<TimelineQueueRow>;
  sequenceEvents: ReadonlyArray<SequenceEventRecord>;
  replies: ReadonlyArray<InboxReplyRecord>;
  channelEvents: ReadonlyArray<ChannelEventRecord>;
  outcomes: ReadonlyArray<DealOutcomeRecord>;
  /** Sent-folder delivery checks keyed by sequence event id; without `withBodies`, mismatches also get their own entry. */
  deliveries?: ReadonlyMap<number, SendDeliveryView>;
  /** Logged calls. When given, the bare `call` channel events they wrote are dropped as duplicates. */
  calls?: ReadonlyArray<CallRecordView>;
  withBodies?: boolean;
}): ProspectTimelineEvent[] {
  const withBodies = input.withBodies === true;
  const events: ProspectTimelineEvent[] = [];

  for (const row of input.rows) {
    events.push({
      at: sqliteToIso(row.found_at),
      kind: "surfaced",
      label: "surfaced",
      detail: null,
      playName: row.play_name,
      channel: null,
    });
    if (row.decided_at) {
      events.push({
        at: sqliteToIso(row.decided_at),
        kind: "decided",
        label: describeDecision({
          decision: row.decision,
          decidedBy: row.decided_by,
          decidedByMember: row.decided_by_member,
        }),
        detail: row.notes,
        playName: row.play_name,
        channel: null,
      });
    }
    if (row.sent_at) {
      events.push({
        at: sqliteToIso(row.sent_at),
        kind: "sent",
        label: "sent",
        detail: null,
        playName: row.play_name,
        channel: null,
      });
    }
  }

  for (const ev of input.sequenceEvents) {
    const meta = parseMeta(ev.metadata_json);
    if (ev.status === "skipped") {
      // A letter the founder skipped (#610): the step never went out.
      events.push({
        at: sqliteToIso(ev.created_at),
        kind: "sequence",
        label: "letter skipped",
        detail: null,
        playName: ev.play_name,
        channel: touchChannel(ev.channel),
      });
      continue;
    }
    const step = typeof meta["label"] === "string" ? meta["label"] : `step ${ev.step_index + 1}`;
    const status = ev.status === "sent" || ev.status === "delivered" ? "" : ` · ${ev.status}`;
    const delivery = input.deliveries?.get(ev.id);
    events.push({
      at: sqliteToIso(ev.created_at),
      kind: "sequence",
      label: `${ev.channel} ${step}${status}`,
      detail: typeof meta["subject"] === "string" ? meta["subject"] : null,
      playName: ev.play_name,
      channel: touchChannel(ev.channel),
      ...(withBodies ? { body: typeof meta["body"] === "string" ? meta["body"] : null } : {}),
      ...(delivery ? { delivery } : {}),
    });
    const note = delivery ? deliveryNote(delivery) : null;
    // The person pane shows the check as a badge on the send itself; the
    // label-only drawer needs it as its own entry.
    if (delivery && note && !withBodies) {
      events.push({
        at: delivery.deliveredAt[delivery.deliveredAt.length - 1] ?? sqliteToIso(ev.created_at),
        kind: "sequence",
        label: note,
        detail:
          delivery.deliveredAt.length > 0
            ? delivery.deliveredAt.map((t) => t.slice(11, 19)).join(", ") + " UTC"
            : null,
        playName: ev.play_name,
        channel: touchChannel(ev.channel),
      });
    }
  }

  for (const r of input.replies) {
    // NULL kind predates the classifier and reads as human everywhere.
    const kind = r.kind ?? "human";
    const label =
      kind === "human"
        ? r.intent
          ? replyLabel(r.intent, r.intent_review === 1)
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
      channel: "email",
      ...(withBodies ? { body: r.body || null } : {}),
    });
  }

  for (const ce of input.channelEvents) {
    // A logged call wrote this bare copy; the call entry below carries it in full.
    if (input.calls && ce.source === "call") continue;
    events.push({
      at: sqliteToIso(ce.occurred_at),
      kind: "channel",
      label: `${ce.channel} ${ce.event_type}`,
      detail: null,
      playName: null,
      channel: touchChannel(ce.channel),
      // Never the message text: a LinkedIn reply belongs to the thread of the
      // member who connected that account (#1040), and this read has no
      // viewer. /inbox shows it to its owner.
      ...(withBodies ? { body: null } : {}),
    });
  }

  for (const c of input.calls ?? []) {
    events.push({
      at: sqliteToIso(c.startedAt),
      kind: "call",
      label: callLabel(c.outcome),
      detail: null,
      playName: c.playName,
      channel: "call",
      call: {
        id: c.id,
        outcome: c.outcome,
        durationSec: c.durationSec,
        note: c.note,
        member: c.member,
      },
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
      channel: null,
    });
  }

  // Newest first. Compare as instants, not strings: "…:34Z" and "…:34.443Z"
  // are the same second but sort the wrong way round lexically. Ties keep
  // insertion order reversed so a same-instant milestone reads sensibly.
  return events
    .map((e, i) => ({ e, i, t: instant(e) }))
    .toSorted((a, b) => b.t - a.t || b.i - a.i)
    .map(({ e }) => e);
}

/** Timeline label for a delivery mismatch; null when the check found exactly the one copy. */
export function deliveryNote(d: SendDeliveryView): string | null {
  if (d.status === "duplicate") return `delivered ${d.observed ?? "?"}× by the mail provider`;
  if (d.status === "not_found") return "not found in Sent";
  return null;
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

const instant = (e: ProspectTimelineEvent): number => {
  const t = Date.parse(e.at);
  return Number.isFinite(t) ? t : 0;
};

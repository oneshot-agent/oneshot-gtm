import {
  LINKEDIN_FRIEND_PLAY,
  type LinkedInEvidenceVariant,
  type LinkedInFunnel,
  type LinkedInInviteRow,
  type LinkedInInviteState,
  type LinkedInMeasureView,
  type LinkedInRate,
  type LinkedInStepKind,
  type LinkedInWithdrawnBy,
} from "@oneshot-gtm/shared-types";
import { LINKEDIN_INVITE_KIND } from "./ledger-cadence.ts";
import type {
  FunnelEventRow,
  FunnelReplyRow,
  LinkedInFunnelSource,
} from "./ledger-linkedin-funnel.ts";
import { sqliteToIso } from "./time.ts";

/**
 * The LinkedIn funnel (#792), computed from a ledger snapshot. Pure: the
 * ledger and the synced inbox are read by the caller and handed in, so the
 * definitions below are the only thing this file decides.
 *
 *  - An invite is a `sent` invite event (a failed or never-sent one is not).
 *  - A person counts once per row of the funnel: their newest invite inside
 *    the filters.
 *  - Accepted: the invite event's `acceptedAt` (the invitation's own status,
 *    #793) when recorded; otherwise a synced 1:1 conversation with the person.
 *    The second is a heuristic that misses most accepts, so the two are
 *    counted apart.
 *  - Replied to the first message: a human reply at or after the first
 *    message and before the next step went out (or with no next step sent).
 *  - Replied at any point: a human reply at or after the invite.
 *  - A reply recorded by two sources (the same person, the same text or
 *    times within a minute) is one reply.
 */

const DAY_MS = 86_400_000;
const REPLY_MERGE_WINDOW_MS = 60_000;
const SENT_LIKE = new Set(["sent", "delivered", "replied"]);

export interface LinkedInFunnelFilters {
  sinceDays?: number | null;
  play?: string | null;
  stepKind?: LinkedInStepKind | null;
}

export interface LinkedInFunnelInput {
  source: LinkedInFunnelSource;
  workspace: string;
  now: Date;
  filters?: LinkedInFunnelFilters;
  /** The synced conversation with this person, when the inbox holds one. */
  conversationFor: (person: { prospectId: number; linkedinUrl: string | null }) => string | null;
}

export interface LinkedInFunnelResult {
  view: LinkedInMeasureView;
  /** Every invite inside the filters, newest first (one row per invite sent). */
  rows: LinkedInInviteRow[];
}

function parseMeta(json: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const timeOf = (ts: string): number => Date.parse(sqliteToIso(ts));
const round1 = (n: number): number => Math.round(n * 10) / 10;

function isInviteEvent(e: FunnelEventRow, meta: Record<string, unknown>): boolean {
  return e.channel === "linkedin" && (e.step_index === 0 || meta["kind"] === LINKEDIN_INVITE_KIND);
}

function normalizedText(body: string | null): string {
  return (body ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

interface MergedReply {
  at: number;
  text: string;
  sources: Set<string>;
}

/**
 * One list of replies for a person, with a reply recorded by two different
 * sources counted once. Two replies from the same source are never merged:
 * a person can send the same word twice.
 */
export function mergeLinkedInReplies(replies: FunnelReplyRow[]): {
  replies: Array<{ at: number }>;
  merged: number;
} {
  const kept: MergedReply[] = [];
  let merged = 0;
  const ordered = replies
    .map((r) => ({ at: timeOf(r.occurred_at), text: normalizedText(r.body), source: r.source }))
    .filter((r) => Number.isFinite(r.at))
    .toSorted((a, b) => a.at - b.at);
  for (const r of ordered) {
    const twin = kept.find(
      (k) =>
        !k.sources.has(r.source) &&
        ((r.text !== "" && r.text === k.text) || Math.abs(r.at - k.at) <= REPLY_MERGE_WINDOW_MS),
    );
    if (twin) {
      twin.sources.add(r.source);
      merged++;
    } else {
      kept.push({ at: r.at, text: r.text, sources: new Set([r.source]) });
    }
  }
  return { replies: kept.map((k) => ({ at: k.at })), merged };
}

interface Unit {
  row: LinkedInInviteRow;
  sentAtMs: number;
  acceptedAtMs: number | null;
  firstMessageAtMs: number | null;
  /** When the step after the first message went out. */
  nextStepAtMs: number | null;
}

function variantOf(meta: Record<string, unknown>): LinkedInEvidenceVariant {
  const v = meta["evidenceClause"];
  return v === true ? "with" : v === false ? "without" : "unrecorded";
}

function buildUnits(input: LinkedInFunnelInput): Unit[] {
  const { source, now } = input;
  const people = new Map(source.prospects.map((p) => [p.id, p]));
  const groups = new Map<string, FunnelEventRow[]>();
  for (const e of source.events) {
    const key = `${e.prospect_id}\u0000${e.play_name}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const units: Unit[] = [];
  for (const events of groups.values()) {
    const metas = events.map((e) => parseMeta(e.metadata_json));
    const inviteAt = events.flatMap((e, i) => (isInviteEvent(e, metas[i]!) ? [i] : []));
    const sentInvites = inviteAt.filter((i) => events[i]!.status === "sent");
    for (const [n, i] of sentInvites.entries()) {
      const invite = events[i]!;
      const meta = metas[i]!;
      const nextInvite = sentInvites[n + 1];
      const end = nextInvite ?? events.length;
      const person = people.get(invite.prospect_id);

      const withdrawnAt = inviteAt.find(
        (j) => j > i && j < end && events[j]!.status === "withdrawn",
      );
      const withdrawMeta = withdrawnAt !== undefined ? metas[withdrawnAt]! : {};

      // What this invite led to: the steps after it in the same play, up to a re-invite.
      const after: number[] = [];
      for (let j = i + 1; j < end; j++) {
        if (!inviteAt.includes(j) && SENT_LIKE.has(events[j]!.status)) after.push(j);
      }
      const firstMessage = after.find((j) => events[j]!.channel === "linkedin");
      const nextStep = firstMessage === undefined ? undefined : after.find((j) => j > firstMessage);
      const storedConversation = after
        .map((j) => str(metas[j]!["conversationId"]))
        .find((id): id is string => id !== null);

      const sentAtMs = timeOf(invite.created_at);
      const acceptedAt = str(meta["acceptedAt"]);
      const acceptedByInvitation = acceptedAt !== null || meta["invitationStatus"] === "accepted";
      const syncedConversation = person
        ? input.conversationFor({ prospectId: person.id, linkedinUrl: person.linkedin_url })
        : null;
      const conversationId = syncedConversation ?? storedConversation ?? null;

      let state: LinkedInInviteState;
      let acceptedVia: LinkedInInviteRow["acceptedVia"] = null;
      if (acceptedByInvitation) {
        state = "accepted";
        acceptedVia = "invitation";
      } else if (withdrawnAt !== undefined) {
        state = "withdrawn";
      } else if (meta["inviteStatus"] === "already_connected") {
        state = "already_connected";
      } else if (conversationId || firstMessage !== undefined) {
        // A message only goes out after an accept was detected, so a sent
        // message is as good as a conversation for this heuristic.
        state = "accepted";
        acceptedVia = "conversation";
      } else {
        state = "pending";
      }

      const by = str(withdrawMeta["withdrawnBy"]);
      const withdrawnBy: LinkedInWithdrawnBy | null =
        state !== "withdrawn" ? null : by === "timeout" || by === "manual" ? by : "unknown";
      const acceptedAtMs = acceptedAt ? Date.parse(acceptedAt) : Number.NaN;

      units.push({
        sentAtMs,
        acceptedAtMs: Number.isFinite(acceptedAtMs) ? acceptedAtMs : null,
        firstMessageAtMs:
          firstMessage === undefined ? null : timeOf(events[firstMessage]!.created_at),
        nextStepAtMs: nextStep === undefined ? null : timeOf(events[nextStep]!.created_at),
        row: {
          prospectId: invite.prospect_id,
          prospect: person?.name ?? null,
          profile: person?.linkedin_url ?? null,
          playName: invite.play_name,
          stepIndex: invite.step_index,
          stepKind:
            invite.play_name === LINKEDIN_FRIEND_PLAY
              ? "friend"
              : invite.step_index === 0
                ? "first-touch"
                : "continuation",
          sentAt: new Date(sentAtMs).toISOString(),
          state,
          daysPending:
            state === "pending"
              ? Math.max(0, Math.floor((now.getTime() - sentAtMs) / DAY_MS))
              : null,
          acceptedAt: state === "accepted" ? acceptedAt : null,
          acceptedVia,
          withdrawnBy,
          conversationId,
          evidence: variantOf(meta),
        },
      });
    }
  }
  return units;
}

function rate(count: number, of: number): LinkedInRate {
  return { count, of, rate: of > 0 ? count / of : null };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type PersonReplies = Map<number, { replies: Array<{ at: number }>; merged: number }>;

function funnelOf(units: Unit[], replies: PersonReplies): LinkedInFunnel {
  // A person once: their newest invite among these units.
  const newest = new Map<number, Unit>();
  for (const u of units) {
    const have = newest.get(u.row.prospectId);
    if (!have || u.sentAtMs >= have.sentAtMs) newest.set(u.row.prospectId, u);
  }
  const people = [...newest.values()];

  const count = (state: LinkedInInviteState) => people.filter((u) => u.row.state === state).length;
  const withdrawn = people.filter((u) => u.row.state === "withdrawn");
  const accepted = people.filter((u) => u.row.state === "accepted");
  const days = accepted.flatMap((u) =>
    u.row.acceptedVia === "invitation" && u.acceptedAtMs !== null
      ? [Math.max(0, (u.acceptedAtMs - u.sentAtMs) / DAY_MS)]
      : [],
  );
  const med = median(days);

  const withMessage = people.filter((u) => u.firstMessageAtMs !== null);
  const repliedFirst = withMessage.filter((u) =>
    (replies.get(u.row.prospectId)?.replies ?? []).some(
      (r) => r.at >= u.firstMessageAtMs! && (u.nextStepAtMs === null || r.at < u.nextStepAtMs),
    ),
  );
  const repliedAny = people.filter((u) =>
    (replies.get(u.row.prospectId)?.replies ?? []).some((r) => r.at >= u.sentAtMs),
  );
  const repliesMerged = people.reduce(
    (n, u) => n + (replies.get(u.row.prospectId)?.merged ?? 0),
    0,
  );

  return {
    invitesSent: people.length,
    pending: count("pending"),
    withdrawn: {
      total: withdrawn.length,
      timeout: withdrawn.filter((u) => u.row.withdrawnBy === "timeout").length,
      manual: withdrawn.filter((u) => u.row.withdrawnBy === "manual").length,
      unknown: withdrawn.filter((u) => u.row.withdrawnBy === "unknown").length,
    },
    accepted: {
      total: accepted.length,
      viaInvitation: accepted.filter((u) => u.row.acceptedVia === "invitation").length,
      viaConversation: accepted.filter((u) => u.row.acceptedVia === "conversation").length,
      medianDaysToAccept: med === null ? null : round1(med),
      daysKnown: days.length,
      rate: people.length > 0 ? accepted.length / people.length : null,
    },
    alreadyConnected: count("already_connected"),
    firstMessageSent: withMessage.length,
    repliedToFirstMessage: rate(repliedFirst.length, withMessage.length),
    repliedAtAnyPoint: rate(repliedAny.length, people.length),
    repliesMerged,
  };
}

export function computeLinkedInFunnel(input: LinkedInFunnelInput): LinkedInFunnelResult {
  const filters = input.filters ?? {};
  const all = buildUnits(input);
  const sinceMs =
    filters.sinceDays != null ? input.now.getTime() - filters.sinceDays * DAY_MS : null;
  const units = all.filter(
    (u) =>
      (sinceMs === null || u.sentAtMs >= sinceMs) &&
      (!filters.play || u.row.playName === filters.play) &&
      (!filters.stepKind || u.row.stepKind === filters.stepKind),
  );
  // Friend invites (#791) are warm connects, not outreach: they have their
  // own funnel and stay out of the cold one unless that is what was asked for.
  const friendUnits = units.filter((u) => u.row.stepKind === "friend");
  const outreach =
    filters.stepKind === "friend" ? units : units.filter((u) => u.row.stepKind !== "friend");

  const byPerson = new Map<number, FunnelReplyRow[]>();
  for (const r of input.source.replies) {
    const list = byPerson.get(r.prospect_id);
    if (list) list.push(r);
    else byPerson.set(r.prospect_id, [r]);
  }
  const replies: PersonReplies = new Map(
    [...byPerson].map(([id, list]) => [id, mergeLinkedInReplies(list)]),
  );

  const of = (variant: LinkedInEvidenceVariant) =>
    funnelOf(
      outreach.filter((u) => u.row.evidence === variant),
      replies,
    );
  return {
    view: {
      workspace: input.workspace,
      filters: {
        sinceDays: filters.sinceDays ?? null,
        play: filters.play ?? null,
        stepKind: filters.stepKind ?? null,
      },
      plays: [...new Set(all.map((u) => u.row.playName))].toSorted(),
      funnel: funnelOf(outreach, replies),
      friend: funnelOf(friendUnits, replies),
      variants: {
        withEvidence: of("with"),
        withoutEvidence: of("without"),
        unrecorded: of("unrecorded"),
      },
    },
    rows: units
      .map((u) => u)
      .toSorted((a, b) => b.sentAtMs - a.sentAtMs)
      .map((u) => u.row),
  };
}

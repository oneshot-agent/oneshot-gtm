import type { LiveReadSkipView, ReadProfileResult } from "@oneshot-gtm/shared-types";

/**
 * Read on open: a queue row opened without a live LinkedIn read is read
 * right then (`POST /api/queue/:id/read-profile`), since the daily cap
 * leaves many rows unread by the sweep. Pure, so which rows fire and what
 * a skip says are testable; the queue row only wires the call.
 */

/** The row activity label while a read runs (rowActivity.ts); Approve waits on it. */
export const READING_LINKEDIN = "Reading LinkedIn…";

const LINKEDIN_PROFILE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*linkedin\.com\/in\/[a-z0-9-_.%]+/i;
/** The server reads a row again once its live read is this old (the read cache's lifetime). */
const READ_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The finder's profile fields, in the order the server's person seed reads them. */
const SEED_FIELDS = [
  "linkedinUrl",
  "sourceProfileUrl",
  "profileUrl",
  "authorUrl",
  "twitterUrl",
  "xUrl",
  "githubUrl",
] as const;

/**
 * Whether the row's person seed is a LinkedIn profile: the first profile
 * field it carries is one. Close to the server's seed, not identical (it
 * also skips a field it cannot research); a miss costs one call the server
 * answers with `no-seed`, which the page ignores.
 */
export function hasLinkedInSeed(payload: unknown): boolean {
  const p = record(payload);
  if (!p) return false;
  const first = SEED_FIELDS.map((k) => p[k]).find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return first !== undefined && LINKEDIN_PROFILE.test(first.trim());
}

/**
 * When the row's live read happened, or null when it has none. A loose look,
 * as the server's sweep takes it: an older dossier still has its read.
 */
function liveReadAt(payload: unknown): string | null {
  const live = record(record(record(payload)?.personResearch)?.liveProfile);
  if (!live) return null;
  return typeof live.readAt === "string" ? live.readAt : "";
}

interface RowForRead {
  status: string;
  sentAt: string | null;
  isSending?: boolean;
  lastDraft?: { sent: boolean } | null;
  payload: unknown;
}

function unsent(row: RowForRead): boolean {
  return (
    (row.status === "pending" || row.status === "approved") &&
    row.sentAt == null &&
    !row.isSending &&
    !(row.lastDraft?.sent ?? false)
  );
}

/** The list's "not read" marker: an unsent row with a LinkedIn seed and no live read. */
export function liveReadMissing(row: RowForRead): boolean {
  return unsent(row) && hasLinkedInSeed(row.payload) && liveReadAt(row.payload) === null;
}

/**
 * Whether opening this row should read its profile: unsent, a LinkedIn
 * seed, and no live read or one older than the server keeps. A read with
 * no usable date is read again, as the server does.
 */
export function shouldReadOnOpen(row: RowForRead, now: number = Date.now()): boolean {
  if (!unsent(row) || !hasLinkedInSeed(row.payload)) return false;
  const at = liveReadAt(row.payload);
  if (at === null) return true;
  const ms = Date.parse(at);
  return !Number.isFinite(ms) || now - ms >= READ_MAX_AGE_MS;
}

const SKIP_COPY: Partial<Record<LiveReadSkipView, string>> = {
  "daily-limit": "daily limit reached",
  "cost-cap": "today's spend cap reached",
  failed: "the read failed",
  interrupted: "the read was interrupted",
  "different-person": "the profile looks like someone else",
  "session-invalid": "LinkedIn signed the session out",
  "session-unchecked": "the session isn't verified yet",
  "not-connected": "nothing connected to read with",
};

/**
 * The one muted line under the case after a read that did not happen, or
 * null when there is nothing worth saying (`fresh`, `not-live`, `no-seed`,
 * `not-linkedin`: the row is fine as it is).
 */
export function liveReadSkipCopy(skipped: LiveReadSkipView | null): string | null {
  const why = skipped ? SKIP_COPY[skipped] : undefined;
  return why ? `LinkedIn not read: ${why} — using provider history` : null;
}

export interface LiveReadNotice {
  tone: "muted" | "blocked";
  text: string;
}

/** What the case says once a read settles; null when it says nothing. */
export function liveReadNotice(result: ReadProfileResult): LiveReadNotice | null {
  if (result.outcome === "rejected") {
    return {
      tone: "blocked",
      text: result.reason
        ? `Rejected after the LinkedIn read: ${result.reason}`
        : "Rejected after the LinkedIn read: off-ICP",
    };
  }
  if (result.redrafted) {
    return {
      tone: "muted",
      text: "LinkedIn shows a new role · offer and draft rewritten, not sent",
    };
  }
  if (result.read) return null;
  const skip = liveReadSkipCopy(result.skipped);
  return skip ? { tone: "muted", text: skip } : null;
}

/**
 * The live-profile sweep: the scheduler's catch-up for LinkedIn reads.
 *
 * The post-finder hook reads the profile of every row a finder just created,
 * but it works under a wall budget, so a busy finder leaves rows with
 * provider history only, and no later run comes back for them. This sweep
 * does: every hour the server takes the live queue rows (pending or approved,
 * not sent) that have a LinkedIn seed and runs them through the same research
 * path, in this order: approved rows never read, pending rows never read
 * (newest first), then approved rows whose read is older than
 * READ_MAX_AGE_MS. A pending row is read once here; opening it in the queue
 * reads it again when its read has aged (`POST /api/queue/:id/read-profile`),
 * so the sweep's reads go to rows nobody has looked at yet. Then it re-reads
 * people in an active cadence whose last read is older than
 * CADENCE_REFRESH_MS, so a follow-up is written against the job they hold
 * now. The provider call is a free cache hit; the live read is the spend
 * (~$0.01 a row). It stops at the daily read cap and when the account (or
 * the browser session) can no longer read, exactly where the reads themselves
 * stop.
 */
import {
  demoMode,
  getLedger,
  logEvent,
  openLedgerDatabase,
  readPersonHalf,
  type QueueRow,
} from "@oneshot-gtm/core";
import { isLinkedInProfileUrl } from "./_linkedin.ts";
import { LINKEDIN_READ_COST_ESTIMATE_USD, liveReadReady } from "./_linkedin-profile.ts";
import {
  applyPersonResearch,
  applyPersonResearchToProspect,
  personSeedFor,
  personSeedForProspect,
  researchFailedOnItsOwn,
  researchPerson,
  type PersonSeed,
  type ProspectForResearch,
} from "./_person-research.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads per sweep, queue rows and cadence refreshes together. An account read
 * takes seconds, but the platform spaces one account's views 15 to 45 seconds
 * apart, so forty fit the sweep's hour; the read path's daily cap is the real
 * ceiling.
 */
const DEFAULT_MAX_ROWS = 40;
/** Spend per sweep, live reads plus any uncached provider call. */
const DEFAULT_MAX_COST_USD = 2;
/**
 * How long a row waits after an attempt that ended without a read for a
 * reason of its own (`researchFailedOnItsOwn`). The read path caches a
 * failure for about as long, so a sooner retry is answered from that cache
 * and only takes one of the sweep's few slots from a row that could be read.
 */
const RETRY_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** A queue row's live read older than this is read again (the read cache's own lifetime). */
export const READ_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A person in an active cadence is read again when their last read is older than this. */
export const CADENCE_REFRESH_MS = 14 * 24 * 60 * 60 * 1000;

export type LiveSweepRow = Pick<
  QueueRow,
  "id" | "play_name" | "payload_json" | "status" | "sent_at" | "send_started_at"
>;

// These are the URL candidates in personSeedFor, in its original payload
// shape. Non-string values cannot be seeds, so do not materialise them.
const textAt = (path: string) =>
  `CASE WHEN json_type(payload_json, '${path}') = 'text'
    THEN json_extract(payload_json, '${path}') END`;
const urls = [
  "linkedinUrl",
  "sourceProfileUrl",
  "profileUrl",
  "authorUrl",
  "twitterUrl",
  "xUrl",
  "githubUrl",
]
  .map((key) => `'${key}', ${textAt(`$.${key}`)}`)
  .join(", ");
const LIVE_READ_ROWS_SQL = `SELECT id, play_name, status, sent_at, send_started_at,
  CASE WHEN json_valid(payload_json) THEN json_object(
    ${urls},
    'personResearch', json_object(
      'liveProfile', CASE WHEN json_type(payload_json, '$.personResearch.liveProfile') = 'object'
        THEN json_object('readAt', ${textAt("$.personResearch.liveProfile.readAt")}) END,
      'researchedAt', ${textAt("$.personResearch.researchedAt")},
      'warning', ${textAt("$.personResearch.warning")}
    )
  ) ELSE '{}' END AS payload_json
  FROM target_queue WHERE status = ? ORDER BY found_at DESC LIMIT 100000`;

/**
 * Project only the selector inputs, never the full payload or saved draft.
 * Keep URL precedence/normalisation in personSeedFor: a SQL LIKE predicate
 * would change which malformed, fallback and non-LinkedIn URLs qualify.
 * The sweep fetches the full row only when it has budget to research it.
 */
export function listLiveReadRows(ledger: ReturnType<typeof getLedger>): LiveSweepRow[] {
  const db = openLedgerDatabase(ledger.filePath, { readonly: true });
  try {
    // Retain listQueue's per-status limit and ordering before filtering.
    return ["approved", "pending"].flatMap(
      (status) => db.query(LIVE_READ_ROWS_SQL).all(status) as LiveSweepRow[],
    );
  } finally {
    db.close();
  }
}

export interface LiveSweepCandidate {
  row: LiveSweepRow;
  seed: PersonSeed;
}

export interface LiveProfileSweepResult {
  /** False when nothing could run: no account or verified session to read with, demo mode. */
  ran: boolean;
  reason?: "session" | "demo";
  /** Live rows that qualified (before the per-sweep cap). */
  candidates: number;
  /** Rows the sweep researched. */
  researched: number;
  /** Rows whose dossier now carries a live read. */
  read: number;
  /** People in an active cadence whose read was renewed. */
  refreshed: number;
  costUsd: number;
  /** Why the sweep ended before its candidates ran out. */
  stoppedBy?: "daily-limit" | "session-invalid" | "budget" | "max-rows" | "deadline";
}

/**
 * A live row's LinkedIn seed and payload, or null when no read is owed to
 * it: a sent or mid-send row never (the payload write would be refused and
 * the read wasted); a row whose seed is not a LinkedIn profile never; a row
 * whose trigger switched the tier off never.
 */
export function liveReadSeedFor(
  row: LiveSweepRow,
  liveReadOffForPlay: (playName: string) => boolean,
): { seed: PersonSeed; payload: Record<string, unknown> } | null {
  if (row.sent_at != null || row.send_started_at != null) return null;
  if (row.status !== "pending" && row.status !== "approved") return null;
  if (liveReadOffForPlay(row.play_name)) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    payload = isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }
  const seed = personSeedFor(payload);
  if (!seed?.url || !isLinkedInProfileUrl(seed.url)) return null;
  return { seed, payload };
}

/**
 * The live-read marker a payload's research carries, if any. A loose look at
 * the record: a row from an older build may carry a dossier the strict guard
 * would not recognise, and it still has its read.
 */
export function liveProfileMarker(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const research = payload["personResearch"];
  return isRecord(research) && isRecord(research["liveProfile"]) ? research["liveProfile"] : null;
}

/** Live rows a read is owed to (`liveReadSeedFor`) that carry no live read yet. */
export function countLiveReadsWaiting(
  rows: readonly LiveSweepRow[],
  liveReadOffForPlay: (playName: string) => boolean,
): number {
  let waiting = 0;
  for (const row of rows) {
    const live = liveReadSeedFor(row, liveReadOffForPlay);
    if (live && !liveProfileMarker(live.payload)) waiting++;
  }
  return waiting;
}

/**
 * Pure: which live rows want a read (`liveReadSeedFor`), in rank order.
 * A row never read always; an approved row whose read is READ_MAX_AGE_MS old
 * again (`--refresh` on the CLI forces one sooner), a pending one not (it is
 * read again when it is opened); a row whose last attempt failed for a
 * reason of its own not for RETRY_AFTER_MS. Approved rows never read first
 * (they are the ones about to send), then pending rows never read, newest
 * first, then approved re-reads.
 */
export function selectLiveSweepCandidates(
  rows: readonly LiveSweepRow[],
  liveReadOffForPlay: (playName: string) => boolean,
  now: number = Date.now(),
): LiveSweepCandidate[] {
  const out: Array<LiveSweepCandidate & { rank: number }> = [];
  for (const row of rows) {
    const live = liveReadSeedFor(row, liveReadOffForPlay);
    if (!live) continue;
    const marker = liveProfileMarker(live.payload);
    if (marker && (row.status !== "approved" || !readOlderThan(marker, READ_MAX_AGE_MS, now))) {
      continue;
    }
    const research = live.payload["personResearch"];
    if (isRecord(research) && triedRecently(research, now)) continue;
    out.push({ row, seed: live.seed, rank: rank(row, marker !== null) });
  }
  return out
    .toSorted((a, b) => a.rank - b.rank || b.row.id - a.row.id)
    .map(({ row, seed }) => ({ row, seed }));
}

/**
 * The last attempt ended without a read because of this row, not because of
 * the session, the daily cap, a cost cap or a provider failure (those say
 * nothing about the row, and the next sweep should take it again).
 */
function triedRecently(research: Record<string, unknown>, now: number): boolean {
  if (!researchFailedOnItsOwn(research["warning"])) return false;
  const at = Date.parse(
    typeof research["researchedAt"] === "string" ? research["researchedAt"] : "",
  );
  return Number.isFinite(at) && now - at < RETRY_AFTER_MS;
}

/** A live-read marker (`{ readAt }`) is older than `maxAgeMs`. A marker with no usable date counts as fresh, as it did before reads aged. */
function readOlderThan(marker: unknown, maxAgeMs: number, now: number): boolean {
  const at =
    isRecord(marker) && typeof marker["readAt"] === "string" ? Date.parse(marker["readAt"]) : NaN;
  return Number.isFinite(at) && now - at >= maxAgeMs;
}

/**
 * The live-read marker a prospect's person half carries, in the shape
 * `readOlderThan` ages. `personRecordFromResearch` flattens the read to
 * `liveProfileReadAt` when it writes the half, so that is the key a prospect
 * has; a `liveProfile: { url, readAt }` object, the queue payload's shape, is
 * accepted too. Null when the half carries no read.
 */
function prospectLiveReadMarker(half: Record<string, unknown>): Record<string, unknown> | null {
  const readAt = half["liveProfileReadAt"];
  if (typeof readAt === "string" && readAt.trim() !== "") return { readAt };
  const live = half["liveProfile"];
  return isRecord(live) ? live : null;
}

export interface CadenceRefreshCandidate {
  prospect: ProspectForResearch;
  seed: PersonSeed;
  playName: string;
}

/**
 * Pure: which people in an active cadence want a fresh read. One entry per
 * prospect (earliest enrolment first); a prospect with no LinkedIn seed is
 * left out, and so is one read within CADENCE_REFRESH_MS or whose last
 * attempt failed for a reason of its own within RETRY_AFTER_MS.
 */
export function selectCadenceRefreshCandidates(
  cadences: ReadonlyArray<{ prospect_id: number; play_name: string; enrolled_at: string }>,
  prospectFor: (id: number) => ProspectForResearch | null,
  now: number = Date.now(),
): CadenceRefreshCandidate[] {
  const ordered = cadences.toSorted(
    (a, b) => a.enrolled_at.localeCompare(b.enrolled_at) || a.prospect_id - b.prospect_id,
  );
  const seen = new Set<number>();
  const out: CadenceRefreshCandidate[] = [];
  for (const c of ordered) {
    if (seen.has(c.prospect_id)) continue;
    seen.add(c.prospect_id);
    const prospect = prospectFor(c.prospect_id);
    if (!prospect) continue;
    const seed = personSeedForProspect(prospect);
    if (!seed?.url || !isLinkedInProfileUrl(seed.url)) continue;
    const half = readPersonHalf(prospect.dossier_json);
    if (isRecord(half)) {
      const live = prospectLiveReadMarker(half);
      if (live && !readOlderThan(live, CADENCE_REFRESH_MS, now)) continue;
      if (triedRecently(half, now)) continue;
    }
    out.push({ prospect, seed, playName: c.play_name });
  }
  return out;
}

/**
 * 0: approved, never read (about to send); 1: pending, never read; 2: an
 * approved row's aged read.
 */
function rank(r: LiveSweepRow, read: boolean): number {
  if (read) return 2;
  return r.status === "approved" ? 0 : 1;
}

/** Per-play opt-out from the trigger's saved config (`linkedinProfileRead: false`). */
export function liveReadOffByPlay(
  ledger: ReturnType<typeof getLedger>,
): (playName: string) => boolean {
  const off = new Set<string>();
  for (const trigger of ledger.listTriggers()) {
    try {
      const config = JSON.parse(trigger.config_json ?? "{}") as Record<string, unknown>;
      if (config["linkedinProfileRead"] === false) off.add(trigger.name);
    } catch {
      // an unreadable config keeps the default (on)
    }
  }
  return (playName) => off.has(playName);
}

export interface LiveProfileSweepDeps {
  researchPerson: typeof researchPerson;
  applyPersonResearch: typeof applyPersonResearch;
  applyPersonResearchToProspect?: typeof applyPersonResearchToProspect;
}

export async function sweepLiveProfiles(
  opts: { maxRows?: number; maxCostUsd?: number; deadlineAt?: number } = {},
  deps: LiveProfileSweepDeps = {
    researchPerson,
    applyPersonResearch,
    applyPersonResearchToProspect,
  },
): Promise<LiveProfileSweepResult> {
  const base = { candidates: 0, researched: 0, read: 0, refreshed: 0, costUsd: 0 };
  if (demoMode()) return { ran: false, reason: "demo", ...base };
  if (!liveReadReady()) return { ran: false, reason: "session", ...base };
  const ledger = getLedger();
  const rows = listLiveReadRows(ledger);
  const offForPlay = liveReadOffByPlay(ledger);
  const candidates = selectLiveSweepCandidates(rows, offForPlay);
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCostUsd = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const result: LiveProfileSweepResult = { ran: true, ...base, candidates: candidates.length };
  const spend = { costUsd: 0 };
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;
  for (const [index, candidate] of candidates.entries()) {
    if (index >= maxRows) {
      result.stoppedBy = "max-rows";
      break;
    }
    // The scheduler's deadline is checked here and again before the write:
    // a read that finishes late is not lost (its result is cached) and the
    // next sweep applies it for free, but nothing starts or persists after
    // the deadline. A running browser task cannot be cancelled.
    if (Date.now() >= deadlineAt) {
      result.stoppedBy = "deadline";
      break;
    }
    const remainingUsd = Math.max(0, maxCostUsd - spend.costUsd);
    // The live read is the spend; a row may not start unless its estimate fits.
    if (remainingUsd < LINKEDIN_READ_COST_ESTIMATE_USD) {
      result.stoppedBy = "budget";
      break;
    }
    const row = ledger.getQueueRow(candidate.row.id);
    if (!row) continue;
    const live = liveReadSeedFor(row, offForPlay);
    if (!live) continue;
    const researched = await deps.researchPerson({
      seed: live.seed,
      playName: row.play_name,
      subject: { queueId: row.id },
      remainingUsd,
      liveProfile: true,
    });
    spend.costUsd += researched.costUsd;
    result.researched++;
    if (researched.dossier.liveProfile) result.read++;
    if (Date.now() >= deadlineAt) {
      result.stoppedBy = "deadline";
      break;
    }
    await deps.applyPersonResearch(ledger, row, researched.dossier, {
      rejudge: true,
      remainingUsd: Math.max(0, remainingUsd - researched.costUsd),
      result: spend,
    });
    // The read path's own stops end the sweep: another row would only skip
    // for the same reason.
    if (researched.liveSkipped === "daily-limit" || researched.liveSkipped === "session-invalid") {
      result.stoppedBy = researched.liveSkipped;
      break;
    }
  }
  // Queue rows first (they are about to send); the reads left over go to
  // people already in a cadence.
  if (!result.stoppedBy) {
    await refreshCadencePeople(ledger, result, spend, {
      maxReads: maxRows - result.researched,
      maxCostUsd,
      deadlineAt,
      apply: deps.applyPersonResearchToProspect ?? applyPersonResearchToProspect,
      research: deps.researchPerson,
    });
  }
  result.costUsd = spend.costUsd;
  logEvent("live_profile_sweep.done", {
    candidates: result.candidates,
    researched: result.researched,
    read: result.read,
    refreshed: result.refreshed,
    cost_usd: result.costUsd,
    stopped_by: result.stoppedBy ?? null,
  });
  return result;
}

/**
 * The cadence half of the sweep: people already in a conversation, read again
 * every CADENCE_REFRESH_MS. A read that came back is written to the prospect
 * (title, company, verdict re-judged); a read that did not leaves the
 * prospect as it was, since the provider half alone says nothing new.
 */
async function refreshCadencePeople(
  ledger: ReturnType<typeof getLedger>,
  result: LiveProfileSweepResult,
  spend: { costUsd: number },
  opts: {
    maxReads: number;
    maxCostUsd: number;
    deadlineAt: number;
    apply: typeof applyPersonResearchToProspect;
    research: typeof researchPerson;
  },
): Promise<void> {
  if (opts.maxReads <= 0) return;
  const candidates = selectCadenceRefreshCandidates(ledger.listActiveCadences(), (id) =>
    ledger.getProspectById(id),
  );
  for (const [index, { prospect, seed, playName }] of candidates.entries()) {
    if (index >= opts.maxReads) {
      result.stoppedBy = "max-rows";
      break;
    }
    if (Date.now() >= opts.deadlineAt) {
      result.stoppedBy = "deadline";
      break;
    }
    const remainingUsd = Math.max(0, opts.maxCostUsd - spend.costUsd);
    if (remainingUsd < LINKEDIN_READ_COST_ESTIMATE_USD) {
      result.stoppedBy = "budget";
      break;
    }
    const researched = await opts.research({
      seed,
      playName,
      subject: { prospectId: prospect.id },
      remainingUsd,
      liveProfile: true,
      liveMaxAgeMs: CADENCE_REFRESH_MS,
    });
    spend.costUsd += researched.costUsd;
    if (researched.dossier.liveProfile && Date.now() < opts.deadlineAt) {
      await opts.apply(ledger, prospect, researched.dossier, { rejudge: true, playName });
      result.refreshed++;
    }
    if (researched.liveSkipped === "daily-limit" || researched.liveSkipped === "session-invalid") {
      result.stoppedBy = researched.liveSkipped;
      break;
    }
  }
}

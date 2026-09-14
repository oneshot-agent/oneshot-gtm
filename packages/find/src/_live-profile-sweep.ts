/**
 * The live-profile sweep: the scheduler's catch-up for LinkedIn reads.
 *
 * The post-finder hook reads the profile of every row a finder just created,
 * but it works under a 20-minute wall budget and a read takes ~5 minutes, so
 * a busy finder leaves rows with provider history only — and no later run
 * comes back for them. This sweep does: every few hours the server takes
 * the live queue rows (pending or approved, not sent) that have a LinkedIn
 * seed and no live read yet, approved first, and runs them through the same
 * research path. The provider call is a free cache hit; the live read is
 * the spend (~$0.01 a row). It stops at the daily read cap and on a login
 * wall exactly where the reads themselves stop, so it never pushes the
 * founder's account past what a backfill would.
 */
import { demoMode, getLedger, logEvent, type QueueRow } from "@oneshot-gtm/core";
import { isLinkedInProfileUrl } from "./_linkedin.ts";
import { linkedinSessionState } from "./_linkedin-profile.ts";
import {
  applyPersonResearch,
  personSeedFor,
  researchPerson,
  type PersonSeed,
  type ResearchableQueueRow,
} from "./_person-research.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rows per sweep. A read takes ~5 minutes and the scheduler gives a sweep an
 * hour, so ten fits; six sweeps a day stay under the read path's daily cap,
 * which is the real ceiling.
 */
const DEFAULT_MAX_ROWS = 10;
/** Spend per sweep, live reads plus any uncached provider call. */
const DEFAULT_MAX_COST_USD = 2;

export type LiveSweepRow = ResearchableQueueRow & Pick<QueueRow, "sent_at" | "send_started_at">;

export interface LiveSweepCandidate {
  row: LiveSweepRow;
  seed: PersonSeed;
}

export interface LiveProfileSweepResult {
  /** False when nothing could run: no verified session, demo mode. */
  ran: boolean;
  reason?: "session" | "demo";
  /** Live rows that qualified (before the per-sweep cap). */
  candidates: number;
  /** Rows the sweep researched. */
  researched: number;
  /** Rows whose dossier now carries a live read. */
  read: number;
  costUsd: number;
  /** Why the sweep ended before its candidates ran out. */
  stoppedBy?: "daily-limit" | "session-invalid" | "budget" | "max-rows";
}

/**
 * Pure: which live rows want a read. A sent or mid-send row never (the
 * payload write would be refused and the read wasted); a row whose seed is
 * not a LinkedIn profile never; a row whose trigger switched the tier off
 * never; a row that already carries a live read not again (the read cache
 * is 30 days and `--refresh` on the CLI is the way to force one). Approved
 * rows first — they are the ones about to send — then pending, newest first.
 */
export function selectLiveSweepCandidates(
  rows: readonly LiveSweepRow[],
  liveReadOffForPlay: (playName: string) => boolean,
): LiveSweepCandidate[] {
  const out: LiveSweepCandidate[] = [];
  for (const row of rows) {
    if (row.sent_at != null || row.send_started_at != null) continue;
    if (row.status !== "pending" && row.status !== "approved") continue;
    if (liveReadOffForPlay(row.play_name)) continue;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      payload =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      continue;
    }
    // A loose look at the record: a row from an older build may carry a
    // dossier the strict guard would not recognise, and it still has its read.
    const research = payload["personResearch"];
    if (isRecord(research) && isRecord(research["liveProfile"])) continue;
    const seed = personSeedFor(payload);
    if (!seed?.url || !isLinkedInProfileUrl(seed.url)) continue;
    out.push({ row, seed });
  }
  return out.toSorted((a, b) => rank(a.row) - rank(b.row) || b.row.id - a.row.id);
}

/** Approved rows first: they are the ones about to send. */
function rank(r: LiveSweepRow): number {
  return r.status === "approved" ? 0 : 1;
}

/** Per-play opt-out from the trigger's saved config (`linkedinProfileRead: false`). */
function liveReadOffByPlay(ledger: ReturnType<typeof getLedger>): (playName: string) => boolean {
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
}

export async function sweepLiveProfiles(
  opts: { maxRows?: number; maxCostUsd?: number } = {},
  deps: LiveProfileSweepDeps = { researchPerson, applyPersonResearch },
): Promise<LiveProfileSweepResult> {
  const base = { candidates: 0, researched: 0, read: 0, costUsd: 0 };
  if (demoMode()) return { ran: false, reason: "demo", ...base };
  if (linkedinSessionState() !== "ok") return { ran: false, reason: "session", ...base };
  const ledger = getLedger();
  const rows = [
    ...ledger.listQueue({ status: "approved", limit: 100_000 }),
    ...ledger.listQueue({ status: "pending", limit: 100_000 }),
  ];
  const candidates = selectLiveSweepCandidates(rows, liveReadOffByPlay(ledger));
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCostUsd = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const result: LiveProfileSweepResult = { ran: true, ...base, candidates: candidates.length };
  const spend = { costUsd: 0 };
  for (const [index, { row, seed }] of candidates.entries()) {
    if (index >= maxRows) {
      result.stoppedBy = "max-rows";
      break;
    }
    const remainingUsd = Math.max(0, maxCostUsd - spend.costUsd);
    if (remainingUsd <= 0) {
      result.stoppedBy = "budget";
      break;
    }
    const researched = await deps.researchPerson({
      seed,
      playName: row.play_name,
      subject: { queueId: row.id },
      remainingUsd,
      liveProfile: true,
    });
    spend.costUsd += researched.costUsd;
    result.researched++;
    const warning = researched.dossier.warning ?? "";
    if (researched.dossier.liveProfile) result.read++;
    await deps.applyPersonResearch(ledger, row, researched.dossier, {
      rejudge: true,
      remainingUsd: Math.max(0, remainingUsd - researched.costUsd),
      result: spend,
    });
    // The read path's own stops end the sweep: another row would only skip
    // for the same reason.
    if (warning.includes("daily-limit")) {
      result.stoppedBy = "daily-limit";
      break;
    }
    if (warning.includes("session-invalid")) {
      result.stoppedBy = "session-invalid";
      break;
    }
  }
  result.costUsd = spend.costUsd;
  logEvent("live_profile_sweep.done", {
    candidates: result.candidates,
    researched: result.researched,
    read: result.read,
    cost_usd: result.costUsd,
    stopped_by: result.stoppedBy ?? null,
  });
  return result;
}

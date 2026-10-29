import { demoMode, getLedger, logEvent, type QueueRow } from "@oneshot-gtm/core";
import {
  applyPersonResearch,
  linkedinSessionState,
  liveProfileMarker,
  liveReadOffByPlay,
  liveReadSeedFor,
  liveReadVia,
  READ_MAX_AGE_MS,
  researchFailedOnItsOwn,
  researchPerson,
} from "@oneshot-gtm/find";
import { playMakesOffer } from "@oneshot-gtm/plays";
import type { LiveReadSkipView, ReadProfileResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { regenerateQueueDraft } from "./queue.ts";
import { regenerateQueueRowOffer } from "./queue-offer.ts";

type JsonRecord = Record<string, unknown>;

/** One row's spend: the live read, a provider call that missed the cache, a company re-read. */
const READ_PROFILE_BUDGET_USD = 1;

const inflight = new Map<number, Promise<ReadProfileResult>>();

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(json: string | null | undefined): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(json ?? "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function skipped(skip: LiveReadSkipView): ReadProfileResult {
  return { read: false, skipped: skip, roleChanged: false, redrafted: false, outcome: "skipped" };
}

/**
 * POST /api/queue/:id/read-profile: read the row's LinkedIn profile now,
 * because the founder opened it. The sweep's per-row path (research with the
 * live tier, then the write with the person gate re-judged), under the same
 * daily cap. A row read within READ_MAX_AGE_MS is not read again. When the
 * read moved the person's role or company, the offer and the draft are
 * rewritten against it, unless the founder wrote the offer.
 *
 * A read that did not happen for a reason outside the row (the cap, the
 * session, a cost cap, an interrupted read) writes nothing: the row keeps
 * the research it has. One read per row at a time; a second call while one
 * runs gets the same answer.
 */
export async function readProfileRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number(params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error: "bad id" }, 400, req);
  const row = getLedger().getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  let running = inflight.get(id);
  if (!running) {
    running = readRowProfile(row).finally(() => inflight.delete(id));
    inflight.set(id, running);
  }
  return jsonResponse(await running, 200, req);
}

/** Why no read can run on this install now, or null when one can. */
function readBlocker(): LiveReadSkipView | null {
  if (demoMode()) return "not-connected";
  if (liveReadVia()) return null;
  const state = linkedinSessionState();
  if (state === "invalid") return "session-invalid";
  if (state === "unchecked") return "session-unchecked";
  return "not-connected";
}

/** A live read this recent stands; one without a usable date is read again (the founder asked). */
function readIsFresh(payload: JsonRecord, now: number): boolean {
  const marker = liveProfileMarker(payload);
  const at = typeof marker?.["readAt"] === "string" ? Date.parse(marker["readAt"]) : Number.NaN;
  return Number.isFinite(at) && now - at < READ_MAX_AGE_MS;
}

async function readRowProfile(row: QueueRow): Promise<ReadProfileResult> {
  if (
    (row.status !== "pending" && row.status !== "approved") ||
    row.sent_at != null ||
    row.send_started_at != null
  ) {
    return skipped("not-live");
  }
  const ledger = getLedger();
  // A play whose trigger switched the tier off has no seed for it.
  const live = liveReadSeedFor(row, liveReadOffByPlay(ledger));
  if (!live) return skipped("no-seed");
  if (readIsFresh(live.payload, Date.now())) return skipped("fresh");
  const blocker = readBlocker();
  if (blocker) return skipped(blocker);

  const before = roleOf(live.payload);
  const researched = await researchPerson({
    seed: live.seed,
    playName: row.play_name,
    subject: { queueId: row.id },
    remainingUsd: READ_PROFILE_BUDGET_USD,
    liveProfile: true,
    liveReadOpened: true,
  });
  const read = Boolean(researched.dossier.liveProfile);
  const skip: LiveReadSkipView | null = read ? null : (researched.liveSkipped ?? "failed");
  const base = { queue_id: row.id, play: row.play_name, cost_usd: researched.costUsd };
  // Only a read, or an answer about this person, replaces what the row has.
  if (
    !read &&
    !researchFailedOnItsOwn(researched.dossier.warning) &&
    live.payload["personResearch"] !== undefined
  ) {
    logEvent("queue_read_profile.done", { ...base, read, skipped: skip, outcome: "skipped" });
    return skipped(skip ?? "failed");
  }
  const applied = await applyPersonResearch(ledger, row, researched.dossier, {
    rejudge: true,
    remainingUsd: Math.max(0, READ_PROFILE_BUDGET_USD - researched.costUsd),
  });
  const fresh = ledger.getQueueRow(row.id);
  const roleChanged =
    applied.outcome !== "skipped" && changedRole(before, roleOf(parsePayload(fresh?.payload_json)));
  const redrafted =
    roleChanged && applied.outcome === "patched" && fresh ? await redraftForRole(fresh) : false;
  // The gate's own words; the row's reject note (`auto: role — …`) when it has none.
  const verdictReason = applied.patch["icpVerdictReason"];
  const reason =
    applied.outcome === "rejected"
      ? typeof verdictReason === "string" && verdictReason.trim()
        ? verdictReason
        : (fresh?.notes ?? "does not fit the ICP")
      : null;
  logEvent("queue_read_profile.done", {
    ...base,
    read,
    skipped: skip,
    outcome: applied.outcome,
    role_changed: roleChanged,
    redrafted,
  });
  return {
    read,
    skipped: skip,
    roleChanged,
    redrafted,
    outcome: applied.outcome,
    ...(reason ? { reason } : {}),
  };
}

function norm(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

/**
 * The role the offer and draft were written against: the researched current
 * role when the row has one, else the finder's title and company.
 */
function roleOf(payload: JsonRecord): { role: string; company: string } {
  const research = payload["personResearch"];
  const current = isRecord(research) ? research["currentRole"] : null;
  const [title, company] = isRecord(current)
    ? [current["title"], current["company"]]
    : [payload["title"], payload["company"]];
  const role = norm(title) || norm(company) ? `${norm(title)}|${norm(company)}` : "";
  return { role, company: norm(payload["company"]) };
}

/** Either changed, and to something: a read that lost the role is not a new one. */
function changedRole(
  before: { role: string; company: string },
  after: { role: string; company: string },
): boolean {
  return (
    (after.role !== "" && after.role !== before.role) ||
    (after.company !== "" && after.company !== before.company)
  );
}

/**
 * Rewrite the offer, then the draft, after a read moved the person's role.
 * A founder-written offer is theirs: neither is touched. The draft is only
 * rewritten when the row has one. A failure is logged and leaves the row as
 * the read left it; the read itself stands.
 */
async function redraftForRole(row: QueueRow): Promise<boolean> {
  const payload = parsePayload(row.payload_json);
  const offer = payload["offer"];
  if (isRecord(offer) && offer["editedBy"] === "founder") return false;
  try {
    let offerWritten = false;
    if (playMakesOffer(row.play_name)) {
      const out = await regenerateQueueRowOffer(row);
      if (out === "not-live") return false;
      // A writer skip is kept on the row (its why shows there) but writes no offer.
      offerWritten = typeof out !== "string" && !("skipped" in out);
      if (!offerWritten) {
        logEvent(
          "queue_read_profile.offer_unchanged",
          { queue_id: row.id, reason: typeof out === "string" ? out : "skipped" },
          "warn",
        );
      }
    }
    // `redrafted` tells the founder the offer was rewritten too: an offer
    // play whose offer could not be rewritten never reports it.
    const offerOk = !playMakesOffer(row.play_name) || offerWritten;
    if (!row.last_draft_json) return offerWritten;
    const drafted = await regenerateQueueDraft(row.id, { discardReason: "redraft" });
    if (drafted.status !== 200) {
      const error = "error" in drafted.body ? drafted.body.error : `status ${drafted.status}`;
      logEvent(
        "queue_read_profile.redraft_failed",
        { queue_id: row.id, status: drafted.status, message_120: error.slice(0, 120) },
        "warn",
      );
      return false;
    }
    return offerOk;
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "read-profile-redraft",
        queue_id: row.id,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return false;
  }
}

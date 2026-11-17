import {
  canonicalLinkedInProfileKey,
  classifyPlatformError,
  dailySpendStatus,
  demoMode,
  findPhone,
  getLedger,
  isSettlementAmbiguous,
  loadConfig,
  logEvent,
  phoneOnApproveOf,
  type QueuePhoneLookup,
  type QueueRow,
} from "@oneshot-gtm/core";
import type { FindPhonesPreview, PhoneLookupSkipView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * Direct phone numbers for queue rows: a "Find phone" button per row, a bulk
 * action over approved rows, and (with `phoneOnApprove`) a lookup on each
 * approval. A lookup can wait minutes for its number, longer than a request
 * may stay open, so every route starts the job and answers at once; the job
 * writes `payload.phoneLookup` (and `payload.phone` when a number is found)
 * when it ends, and the case view polls the row until then.
 */

/** Lookups running at once, across the button, the bulk action and approvals. */
export const PHONE_LOOKUP_CONCURRENCY = 4;

/** Rows whose lookup is running in this process. A `running` payload with no entry here was cut off by a restart. */
const looking = new Set<number>();

let active = 0;
const waiting: Array<() => void> = [];

/** Run `fn` in one of the slots; a finished job hands its slot straight to the next in line. */
async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= PHONE_LOOKUP_CONCURRENCY) await new Promise<void>((go) => waiting.push(go));
  else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

/** Why a row gets no lookup. */
export type PhoneLookupSkip = PhoneLookupSkipView;

const SKIP_MESSAGES: Record<PhoneLookupSkip, string> = {
  status: "Only approved or sent rows can look up a phone",
  sending: "This row is being sent; try again when it finishes",
  no_linkedin: "This row needs a LinkedIn URL before a phone lookup",
  has_phone: "This row already has a phone number",
  no_number: "No number was found for this person",
  running: "Phone lookup already in progress",
};

function payloadOf(row: QueueRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The row's LinkedIn profile URL. Lookups without one failed every time measured. */
function linkedinOf(payload: Record<string, unknown>): string | null {
  const url = text(payload["linkedinUrl"]);
  return url && canonicalLinkedInProfileKey(url) ? url : null;
}

/**
 * Why `row` gets no lookup, or null when it can have one. `force` looks
 * again over a stored number or a "none". `bulk` also leaves out a row whose
 * last lookup found no number: asking again is the same answer.
 */
export function phoneLookupSkip(
  row: QueueRow,
  opts: { force?: boolean; bulk?: boolean } = {},
): PhoneLookupSkip | null {
  if (row.status !== "approved" && row.status !== "sent") return "status";
  if (row.send_started_at) return "sending";
  if (looking.has(row.id)) return "running";
  const payload = payloadOf(row);
  if (!linkedinOf(payload)) return "no_linkedin";
  if (opts.force) return null;
  if (text(payload["phone"])) return "has_phone";
  const last = payload["phoneLookup"] as Partial<QueuePhoneLookup> | undefined;
  if (opts.bulk && last?.status === "none") return "no_number";
  return null;
}

type Trigger = "button" | "bulk" | "approve";

/**
 * Mark the row `running` and start its lookup in the background. False when
 * the row could not be marked (a send or a drain took it meanwhile).
 */
function startPhoneLookup(row: QueueRow, trigger: Trigger, fresh = false): boolean {
  const ledger = getLedger();
  const payload = payloadOf(row);
  looking.add(row.id);
  const marked = ledger.setQueuePhoneLookup(row.id, {
    lookup: { status: "running", at: new Date().toISOString() },
  });
  if (marked !== "written") {
    looking.delete(row.id);
    return false;
  }
  const input = {
    linkedinUrl: linkedinOf(payload)!,
    ...(text(payload["email"]) ? { email: text(payload["email"])! } : {}),
    ...(text(payload["name"]) ? { name: text(payload["name"])! } : {}),
  };
  void inSlot(() => runPhoneLookup(row, input, trigger, fresh)).finally(() =>
    looking.delete(row.id),
  );
  return true;
}

async function runPhoneLookup(
  row: QueueRow,
  input: { linkedinUrl: string; email?: string; name?: string },
  trigger: Trigger,
  fresh: boolean,
): Promise<void> {
  let phone: string | null = null;
  let lookup: QueuePhoneLookup;
  let cached = false;
  try {
    const out = await findPhone(
      input,
      {
        playName: row.play_name,
        memo: `${row.play_name} phone lookup`,
        decisionContext: { subject: { queueId: row.id }, trigger },
      },
      fresh ? { fresh: true } : undefined,
    );
    phone = out.phone;
    cached = Boolean(out.cached);
    const status: QueuePhoneLookup["status"] = phone
      ? "done"
      : out.lookup === "none"
        ? "none"
        : "unavailable";
    lookup = { status, at: new Date().toISOString(), costUsd: out.cost };
  } catch (err) {
    const message = ((err as Error | undefined)?.message ?? "").slice(0, 120);
    // OneShot or the provider failing, not the person: worth asking again.
    // An unresolved payment is not: asking again is refused until it is
    // reconciled, so the message is shown.
    lookup = {
      status: !isSettlementAmbiguous(err) && classifyPlatformError(err) ? "unavailable" : "error",
      at: new Date().toISOString(),
      ...(message ? { message } : {}),
    };
  }
  let written: string;
  try {
    written = getLedger().setQueuePhoneLookup(row.id, { phone, lookup });
  } catch (err) {
    written = "failed";
    logEvent(
      "error.swallowed",
      {
        kind: "queue.phone_lookup",
        queue_id: row.id,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
  }
  logEvent("queue.phone_lookup", {
    queue_id: row.id,
    play: row.play_name,
    trigger,
    status: lookup.status,
    cost_usd: lookup.costUsd ?? 0,
    cached,
    written,
  });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const raw = (await req.text()).trim();
  if (!raw) return {};
  try {
    const body: unknown = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `POST /api/queue/:id/find-phone` `{force?}`: start one row's lookup; 202 while it runs. */
export async function findQueuePhoneRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number(params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error: "bad id" }, 400, req);
  const body = await readBody(req);
  if (!body) return jsonResponse({ error: "invalid JSON body" }, 400, req);
  if (demoMode()) return jsonResponse({ error: "Phone lookups are off in the demo" }, 409, req);
  const row = getLedger().getQueueRow(id);
  if (!row) return jsonResponse({ error: "row not found" }, 404, req);
  const force = body["force"] === true;
  const skip = phoneLookupSkip(row, { force });
  if (skip) return jsonResponse({ error: SKIP_MESSAGES[skip], skip }, 409, req);
  if (!startPhoneLookup(row, "button", force))
    return jsonResponse({ error: SKIP_MESSAGES.sending, skip: "sending" }, 409, req);
  return jsonResponse({ ok: true, status: "running" }, 202, req);
}

/** Approved rows read per page when the bulk action picks its rows. */
const BULK_SCAN_WINDOW = 500;

function approvedRows(): QueueRow[] {
  const ledger = getLedger();
  const rows: QueueRow[] = [];
  for (let offset = 0; ; offset += BULK_SCAN_WINDOW) {
    const page = ledger.listQueue({
      status: "approved",
      limit: BULK_SCAN_WINDOW,
      offset,
      columns: ["id", "play_name", "status", "payload_json", "send_started_at"],
    });
    rows.push(...page);
    if (page.length < BULK_SCAN_WINDOW) return rows;
  }
}

function tally(rows: readonly QueueRow[]): {
  eligible: QueueRow[];
  skipped: Partial<Record<PhoneLookupSkip, number>>;
} {
  const eligible: QueueRow[] = [];
  const skipped: Partial<Record<PhoneLookupSkip, number>> = {};
  for (const row of rows) {
    const skip = phoneLookupSkip(row, { bulk: true });
    if (skip) skipped[skip] = (skipped[skip] ?? 0) + 1;
    else eligible.push(row);
  }
  return { eligible, skipped };
}

/** `GET /api/queue/find-phones`: how many approved rows the bulk action would look up, and why the rest would not. */
export async function findQueuePhonesPreviewRoute(req: Request): Promise<Response> {
  const { eligible, skipped } = tally(approvedRows());
  const body: FindPhonesPreview = { eligible: eligible.length, skipped };
  return jsonResponse(body, 200, req);
}

/**
 * `POST /api/queue/find-phones` `{ids?}`: start lookups for the named rows,
 * or with no ids every approved row without a number. Runs
 * `PHONE_LOOKUP_CONCURRENCY` at a time; answers `{started, skipped}` at once.
 */
export async function findQueuePhonesRoute(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body) return jsonResponse({ error: "invalid JSON body" }, 400, req);
  const ids = body["ids"];
  if (
    ids !== undefined &&
    (!Array.isArray(ids) || !ids.every((i) => Number.isSafeInteger(i) && (i as number) > 0))
  )
    return jsonResponse({ error: "ids must be a list of row ids" }, 400, req);
  if (demoMode()) return jsonResponse({ error: "Phone lookups are off in the demo" }, 409, req);
  const ledger = getLedger();
  const rows = Array.isArray(ids)
    ? [...new Set(ids as number[])]
        .map((id) => ledger.getQueueRow(id))
        .filter((r): r is QueueRow => r != null)
    : approvedRows();
  const { eligible, skipped } = tally(rows);
  let started = 0;
  for (const row of eligible) {
    if (startPhoneLookup(row, "bulk")) started++;
    else skipped.sending = (skipped.sending ?? 0) + 1;
  }
  logEvent("queue.phone_lookup_bulk", { rows: rows.length, started, ...skipped });
  return jsonResponse({ started, skipped }, 202, req);
}

/**
 * With `phoneOnApprove` on, start a lookup for each row just approved. Never
 * throws and never holds the approval: off by default, off in the demo, and
 * stopped by the daily spend ceiling.
 */
export function schedulePhoneOnApproval(rowIds: readonly number[]): void {
  if (rowIds.length === 0) return;
  try {
    if (demoMode() || !phoneOnApproveOf(loadConfig())) return;
    let ceilingReached = false;
    try {
      ceilingReached = dailySpendStatus().ceilingReached;
    } catch {
      // an unreadable spend status never blocks
    }
    if (ceilingReached) {
      logEvent("queue.phone_lookup_skipped", { rows: rowIds.length, reason: "spend-ceiling" });
      return;
    }
    const ledger = getLedger();
    let started = 0;
    for (const id of rowIds) {
      const row = ledger.getQueueRow(id);
      if (row && !phoneLookupSkip(row, { bulk: true }) && startPhoneLookup(row, "approve"))
        started++;
    }
    logEvent("queue.phone_on_approve", { rows: rowIds.length, started });
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "queue.phone_on_approve",
        message_120: ((err as Error | undefined)?.message ?? "").slice(0, 120),
      },
      "warn",
    );
  }
}

/** Test hook: forget lookups in flight. */
export function _resetPhoneLookups(): void {
  looking.clear();
  active = 0;
  waiting.length = 0;
}

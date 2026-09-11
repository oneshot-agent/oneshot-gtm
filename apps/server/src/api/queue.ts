import { draftAngleFor, parseDraftAngle } from "./_draft-angle.ts";
import { extractBusinessAddress } from "@oneshot-gtm/core";
import {
  getLedger,
  isDraining,
  loadConfig,
  isRecentlyContacted,
  isSendDeferred,
  parseProspectPriority,
  type QueueRow,
  type QueueSearchOpts,
  type QueueSearchRow,
  type QueueStatus,
  type TelemetryOutcome,
} from "@oneshot-gtm/core";
import {
  drainQueue,
  isDudDomain,
  rankPendingRows,
  resolveQueueTarget,
  safeEnrichCompany,
} from "@oneshot-gtm/find";
import {
  MANUAL_PLAYS,
  enrollInCadence,
  generateRejectReason,
  logTargetError,
  playMetadata,
  sendDraftedEmail,
} from "@oneshot-gtm/plays";
import { reportServerExecution } from "../telemetry.ts";
import {
  blockingFlags,
  type DrainRequest,
  type DrainResult,
  type LastDraft,
  parseQueueIds,
  type DecidedByFilter,
  type ProspectBrowseRow,
  type ProspectPriorityView,
  type ProspectSearchResponse,
  type ProspectSortKey,
  type QueueCounts,
  type QueueListResponse,
  type QueueRowDetail,
  type QueueRowView,
  type RunPlayRequest,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { sendsToday } from "./_capacity.ts";
import { dispatchPlay } from "./_play-dispatch.ts";
import { buildProspectTimeline } from "./_prospect-timeline.ts";
import { viewsForRows } from "./cadences.ts";

/**
 * Shape-check a stored priority artifact via the shared core validator —
 * strict integers 0..100 on every score, so corruption like `total: -1` or
 * `personFit: 999` reads as null instead of rendering. The backfill's
 * resume-skip uses the same validator, so anything hidden here is seen as
 * unscored and repaired on the next `find score-prospects` run.
 */
function parsePriority(raw: string | null): ProspectPriorityView | null {
  return parseProspectPriority(raw);
}

export function toView(row: QueueRow): QueueRowView {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = row.payload_json;
  }
  let lastDraft: LastDraft | null = null;
  if (row.last_draft_json) {
    try {
      const parsed = JSON.parse(row.last_draft_json) as Partial<LastDraft>;
      // Shape check — schema drift must not crash the queue listing.
      if (parsed && typeof parsed.subject === "string" && typeof parsed.body === "string") {
        lastDraft = {
          subject: parsed.subject,
          body: parsed.body,
          flags: Array.isArray(parsed.flags) ? parsed.flags : [],
          sent: parsed.sent === true,
          receiptIds: Array.isArray(parsed.receiptIds) ? parsed.receiptIds : [],
          dryRun: parsed.dryRun === true,
          draftedAt: typeof parsed.draftedAt === "string" ? parsed.draftedAt : "",
          ...(parseDraftAngle(parsed.angle) ? { angle: parseDraftAngle(parsed.angle)! } : {}),
          ...(parsed.enrichmentFailed === true ? { enrichmentFailed: true } : {}),
        };
      }
    } catch {
      lastDraft = null;
    }
  }
  return {
    id: row.id,
    playName: row.play_name,
    payload,
    dedupeKey: row.dedupe_key,
    source: row.source,
    status: row.status,
    foundAt: row.found_at,
    reviewedAt: row.reviewed_at,
    sentAt: row.sent_at,
    notes: row.notes,
    prospectId: row.prospect_id,
    lastDraft,
    lastDraftedAt: row.last_drafted_at,
    isSending: row.send_started_at != null,
    priority: parsePriority(row.priority_json),
    // `?? null`: pre-v26 rows and test fakes may not carry the columns.
    decision: row.decision ?? null,
    decidedBy: row.decided_by ?? null,
    decidedAt: row.decided_at ?? null,
  };
}

function toBrowseRow(row: QueueSearchRow): ProspectBrowseRow {
  return {
    ...toView(row),
    prospect:
      row.p_id == null
        ? null
        : {
            id: row.p_id,
            name: row.p_name,
            email: row.p_email,
            company: row.p_company,
            title: row.p_title,
            icpVerdict: row.p_icp_verdict,
            icpVerdictReason: row.p_icp_verdict_reason,
            hasDossier: row.p_has_dossier === 1,
            linkedBy: row.p_linked_by_email === 1 ? "email" : "prospect_id",
          },
  };
}

const QUEUE_STATUS_VALUES = new Set<QueueStatus>([
  "pending",
  "approved",
  "rejected",
  "sent",
  "expired",
]);
const SORT_KEYS: Record<ProspectSortKey, QueueSearchOpts["sort"]> = {
  found: "found_at",
  decided: "decided_at",
  name: "name",
};
const DECIDED_FILTERS = new Set<DecidedByFilter>(["human", "machine", "none"]);
/** Longest search string accepted — anything longer is a paste, not a search. */
const MAX_QUERY_CHARS = 200;

/**
 * GET /api/queue/search — the /prospects browse view. Every queue row, any
 * status, with free-text search, sort and offset paging. `status` is a comma
 * list; absent means all. Junk values fall back rather than 400: a stale
 * bookmark should still open the page.
 */
export function searchQueueRoute(req: Request): Response {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_CHARS);
  const statuses = (url.searchParams.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is QueueStatus => QUEUE_STATUS_VALUES.has(s as QueueStatus));
  const playName = url.searchParams.get("play") ?? undefined;
  const decidedRaw = url.searchParams.get("decided");
  const decidedBy = DECIDED_FILTERS.has(decidedRaw as DecidedByFilter)
    ? (decidedRaw as DecidedByFilter)
    : undefined;
  const sortRaw = url.searchParams.get("sort");
  // Own-property check: `"toString" in SORT_KEYS` is true via the prototype.
  const sort =
    sortRaw && Object.hasOwn(SORT_KEYS, sortRaw)
      ? SORT_KEYS[sortRaw as ProspectSortKey]
      : "found_at";
  const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
  );
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const ledger = getLedger();
  const opts: QueueSearchOpts = { limit, offset, sort, dir, withTotal: false };
  if (q) opts.q = q;
  if (statuses.length > 0) opts.statuses = statuses;
  if (playName) opts.playName = playName;
  if (decidedBy) opts.decidedBy = decidedBy;
  const { rows } = ledger.searchQueue(opts);
  const countOpts: Pick<QueueSearchOpts, "q" | "playName" | "decidedBy"> = {};
  if (q) countOpts.q = q;
  if (playName) countOpts.playName = playName;
  if (decidedBy) countOpts.decidedBy = decidedBy;
  // The facets are computed under every filter but status, so the total of
  // the selected statuses IS the page total — no separate COUNT(*) scan.
  const counts = ledger.searchQueueStatusCounts(countOpts);
  const selected = statuses.length > 0 ? statuses : ([...QUEUE_STATUS_VALUES] as QueueStatus[]);
  const total = [...new Set(selected)].reduce((n, st) => n + counts[st], 0);
  const body: ProspectSearchResponse = {
    rows: rows.map(toBrowseRow),
    total,
    limit,
    offset,
    counts,
    plays: ledger.listQueuePlayNames(),
  };
  return jsonResponse(body, 200, req);
}

function payloadString(row: QueueRow, ...keys: string[]): string | null {
  try {
    const p = JSON.parse(row.payload_json) as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return null;
    for (const key of keys) {
      const v = p[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function payloadEmail(row: QueueRow): string | null {
  return payloadString(row, "email", "founderEmail");
}

/** The prospect a queue row resolves to: its FK, else the payload's email. */
function resolveProspectId(ledger: ReturnType<typeof getLedger>, row: QueueRow): number | null {
  if (row.prospect_id != null) return row.prospect_id;
  const email = payloadEmail(row);
  return email ? (ledger.findProspectByEmail(email)?.id ?? null) : null;
}

/**
 * Has this person answered, on any channel? Human email replies, LinkedIn
 * replies, or a step whose status flipped to `replied` (legacy rows that
 * predate `inbox_replies`). Overrides must not email past this.
 */
function prospectHasReplied(ledger: ReturnType<typeof getLedger>, prospectId: number): boolean {
  return (
    ledger.listInboxRepliesForProspect(prospectId).some((r) => (r.kind ?? "human") === "human") ||
    ledger.listChannelEventsForProspect(prospectId).some((e) => e.event_type === "reply") ||
    ledger.listSequenceEventsForProspect(prospectId).some((e) => e.status === "replied")
  );
}

/**
 * GET /api/queue/:id — the /prospects detail drawer. The queue row, the
 * prospect it resolved to, and everything recorded against that prospect.
 * Reads only; nothing here spends (no `gatherReplyContext`).
 */
export function queueRowDetailRoute(req: Request, params: Record<string, string>): Response {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);

  const email = payloadEmail(row);
  const prospectId = resolveProspectId(ledger, row);
  const prospect = prospectId != null ? ledger.getProspectById(prospectId) : null;
  const linkedBy = row.prospect_id != null ? "prospect_id" : "email";

  const browseRow = toBrowseRow({
    ...row,
    p_id: prospect?.id ?? null,
    p_name: prospect?.name ?? null,
    p_email: prospect?.email ?? null,
    p_company: prospect?.company ?? null,
    p_title: prospect?.title ?? null,
    p_icp_verdict: prospect?.icp_verdict ?? null,
    p_icp_verdict_reason: prospect?.icp_verdict_reason ?? null,
    p_has_dossier: prospect?.dossier_json && prospect.dossier_json.trim() ? 1 : 0,
    p_linked_by_email: prospect && linkedBy === "email" ? 1 : 0,
  });

  const cadences = prospect ? viewsForRows(ledger.listCadencesForProspect(prospect.id)) : [];
  const timeline = buildProspectTimeline({
    row,
    sequenceEvents: prospect ? ledger.listAllSequenceEventsForProspect(prospect.id) : [],
    replies: prospect ? ledger.listInboxRepliesForProspect(prospect.id) : [],
    channelEvents: prospect ? ledger.listChannelEventsForProspect(prospect.id) : [],
    outcomes: prospect ? ledger.listDealOutcomesForProspect(prospect.id) : [],
  });
  const flagEmail = prospect?.email ?? email;
  const contactSuppressed = flagEmail ? ledger.contactSuppressionFor(flagEmail) : null;
  const body: QueueRowDetail = {
    row: browseRow,
    prospect:
      prospect && browseRow.prospect
        ? {
            ...browseRow.prospect,
            linkedinUrl: prospect.linkedin_url,
            createdAt: prospect.created_at,
          }
        : null,
    cadences,
    timeline,
    flags: {
      replied: prospect ? prospectHasReplied(ledger, prospect.id) : false,
      bounced: flagEmail ? ledger.suppressionFor(flagEmail) != null : false,
      contactSuppressed: contactSuppressed?.kind ?? null,
      breakupHold: flagEmail ? ledger.breakupReviveHoldFor(flagEmail) != null : false,
      // The prospect record wins; a row that was never emailed only carries
      // the gate's verdict on its payload.
      icpReject:
        prospect != null
          ? prospect.icp_verdict === "reject"
          : payloadString(row, "icpVerdict") === "reject",
    },
  };
  return jsonResponse(body, 200, req);
}

/**
 * Ranked mode reads a wider pending window than the page, ranks it in memory
 * (interleave + score-within-finder + exploration — see find/_rank.ts), then
 * slices. Product logic stays in the tested pure function; listQueue SQL is
 * untouched. Rows past the window never enter the ranking — the same
 * truncation class as the 200-row page itself.
 */
const RANK_WINDOW = 1000;

export function listQueueRoute(req: Request): Response {
  const url = new URL(req.url);
  const playName = url.searchParams.get("play") ?? undefined;
  const status = (url.searchParams.get("status") ?? undefined) as QueueStatus | undefined;
  // `?ids=1,2,3` — explicit row pick. A present-but-unusable value yields
  // `[]`, NOT `undefined`: falling back to the unscoped batch would hand the
  // caller rows it never picked.
  const ids = parseQueueIds(url.searchParams.get("ids"));
  const limit = Math.min(500, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200);
  const ledger = getLedger();
  const orderParam = url.searchParams.get("order");
  const requestedOrder =
    orderParam === "ranked" || orderParam === "newest"
      ? orderParam
      : (loadConfig().queueReviewOrder ?? "newest");
  // Ranked order exists for ONE surface: the pending review list. Explicit id
  // picks and every other status keep chronological order.
  const ranked = requestedOrder === "ranked" && status === "pending" && !ids;
  const filterArgs: {
    playName?: string;
    status?: QueueStatus;
    limit?: number;
    ids?: number[];
  } = { limit: ranked ? RANK_WINDOW : ids ? Math.max(limit, ids.length) : limit };
  if (playName) filterArgs.playName = playName;
  if (status) filterArgs.status = status;
  if (ids) filterArgs.ids = ids;
  const rows = ledger.listQueue(filterArgs);
  const ordered = ranked ? rankPendingRows(rows).slice(0, limit) : rows;
  const counts: QueueCounts = ledger.queueCounts();
  // Unfiltered on purpose — the drain button needs per-play approved counts
  // regardless of the page's current filter.
  const body: QueueListResponse = {
    rows: ordered.map(toView),
    counts,
    approvedByPlay: ledger.approvedCountsByPlay(),
    order: ranked ? "ranked" : "newest",
  };
  const capacity = sendsToday();
  if (capacity) body.sendsToday = capacity;
  return jsonResponse(body, 200, req);
}

export async function approveQueueRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  // Drain picks up every `approved` row, so re-approving a sent one would
  // email the same person again. /prospects can reach sent rows; /queue
  // never offered the button on them.
  if (row.status === "sent") {
    return jsonResponse({ error: "row already sent; re-approving would re-send" }, 409, req);
  }
  // An override (a row that already left `pending`) must not re-open a
  // conversation the prospect has answered: a breakup-revive row expires with
  // "prospect replied", and nothing downstream of `approved` checks that.
  if (row.status !== "pending") {
    const prospectId = resolveProspectId(ledger, row);
    if (prospectId != null && prospectHasReplied(ledger, prospectId)) {
      return jsonResponse(
        { error: "prospect has replied; approving would email them mid-conversation" },
        409,
        req,
      );
    }
  }
  ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
  return jsonResponse({ ok: true }, 200, req);
}

/**
 * The same cap the auto-reject gates apply to their notes
 * (`packages/find/src/_qualify.ts`): the column is one freeform slot and the
 * timeline renders it whole.
 */
export const REJECT_REASON_MAX_CHARS = 300;

/**
 * The `auto:` prefix is how `isAutoRejected` (score-prospects) and the
 * pre-v26 `isHumanDecision` arm tell a machine negative from a human one, and
 * both read `notes` unconditionally. A human-submitted reason must never carry
 * it, or the founder's own decision gets counted as the machine's.
 */
const MACHINE_PREFIX = /^auto:/i;

/**
 * Body → the note to write, or an error. `undefined` means the key was absent
 * (leave the note alone); `""` means the founder emptied the box (clear it).
 */
export function parseRejectReason(body: unknown): { reason?: string } | { error: string } {
  if (!body || typeof body !== "object" || !("reason" in body)) return {};
  const raw = (body as { reason: unknown }).reason;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return { error: "reason must be a string" };
  const reason = raw.replace(/\s+/g, " ").trim().slice(0, REJECT_REASON_MAX_CHARS);
  if (MACHINE_PREFIX.test(reason)) {
    return { error: "reason can't start with 'auto:' — that prefix marks machine decisions" };
  }
  return { reason };
}

export async function rejectQueueRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  const parsed = parseRejectReason(body);
  if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  ledger.setQueueStatus({
    id,
    status: "rejected",
    decidedBy: "human",
    ...(parsed.reason !== undefined ? { notes: parsed.reason } : {}),
  });
  return jsonResponse({ ok: true }, 200, req);
}

/** How long the reject box waits on a company lookup before judging without it. */
const REJECT_ENRICH_DEADLINE_MS = 12_000;

/** The domain a company lookup can key on: the address's, else the payload's own. */
export function rejectLookupDomain(payload: unknown): string | null {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
  const fromEmail = email.includes("@") ? email.split("@")[1]! : "";
  const own =
    typeof p.companyDomain === "string"
      ? p.companyDomain
      : typeof p.domain === "string"
        ? p.domain
        : "";
  // Normalize first, then peel: scheme, www., and anything from the first
  // path, query or fragment separator on. " HTTPS://WWW.Acme.dev?ref=x " is
  // acme.dev, not "https:".
  const domain = (fromEmail || own)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!
    .trim();
  return domain || null;
}

/**
 * The reject box's LLM fallback: when the row carries neither a person-gate
 * verdict reason nor a machine-negative note, the web asks for one sentence
 * on why this prospect might not fit. Preview only — nothing is written,
 * nothing is decided. A provider failure or a model that sees no mismatch
 * both answer `{ reason: null }`, and the box simply stays empty.
 *
 * A row with no stored dossier gets one bounded company lookup by domain
 * (SDK enrichCompany, $0.005), so the facts a stage judgment turns on —
 * founded year, headcount, funding stage — reach the model. Row #882
 * (2026-09-11) was a ten-year-old company whose only evidence was the
 * breakfast it attended. Best-effort: a personal-provider address, a
 * failure, or a slow answer all leave the lookup out.
 */
export async function suggestRejectReasonRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  let payload: unknown;
  try {
    payload = resolveQueueTarget(row);
  } catch (err) {
    const error =
      err instanceof SyntaxError ? "row payload is not valid JSON" : (err as Error).message;
    return jsonResponse({ error }, 400, req);
  }
  const dossier =
    row.prospect_id != null
      ? (ledger.getProspectById(row.prospect_id)?.dossier_json ?? null)
      : null;
  let company: Record<string, unknown> | null = null;
  const domain = dossier?.trim() ? null : rejectLookupDomain(payload);
  if (domain && !isDudDomain(domain)) {
    // The SDK gets the deadline too (totalTimeoutMs), so a slow lookup is
    // cancelled end to end rather than merely released here.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const enriched = await Promise.race([
      safeEnrichCompany(
        { domain, timeoutMs: REJECT_ENRICH_DEADLINE_MS },
        {
          playName: row.play_name,
          memo: "company facts before prefilling a reject reason",
          decisionContext: { reason: "queue row has no dossier; reject box prefill", queueId: id },
        },
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), REJECT_ENRICH_DEADLINE_MS + 500);
      }),
    ]).finally(() => clearTimeout(timer));
    const record = enriched && enriched.result.status !== "error" ? enriched.result.company : null;
    if (record && Object.keys(record).length > 0) company = record as Record<string, unknown>;
  }
  const reason = await generateRejectReason({ playName: row.play_name, payload, dossier, company });
  return jsonResponse(
    reason
      ? { reason, source: "llm", researched: company !== null }
      : { reason: null, source: null, researched: company !== null },
    200,
    req,
  );
}

export async function approveAllRoute(req: Request): Promise<Response> {
  let body: { play?: string } = {};
  try {
    body = (await req.json()) as { play?: string };
  } catch {
    // empty body is fine
  }
  const ledger = getLedger();
  const n = ledger.approveAllPending(body.play ? { playName: body.play } : {});
  return jsonResponse({ approved: n }, 200, req);
}

export async function drainQueueRoute(req: Request): Promise<Response> {
  let body: DrainRequest;
  try {
    body = (await req.json()) as DrainRequest;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (!body.playName) return jsonResponse({ error: "playName required" }, 400, req);
  const t0 = performance.now();
  let outcome: TelemetryOutcome = "ok";
  try {
    const result = await drainQueue({
      playName: body.playName,
      limit: body.limit ?? 10,
      dryRun: !!body.dryRun,
    });
    const view: DrainResult = {
      drained: result.drained,
      sent: result.sent,
      errors: result.errors,
      ...(result.haltedReason ? { haltedReason: result.haltedReason } : {}),
    };
    return jsonResponse(view, 200, req);
  } catch (err) {
    outcome = "error";
    throw err;
  } finally {
    void reportServerExecution("server.queue.drain", {
      outcome,
      durationMs: performance.now() - t0,
      flags: body.dryRun ? ["dry-run"] : [],
    });
  }
}

/**
 * Re-draft a single queue row in PREVIEW mode and overwrite its persisted
 * draft. Always dry-run: enrichment is skipped and nothing is sent, even
 * when the fresh draft is lint-clean.
 */
const generatingDrafts = new Set<number>();

export async function regenerateDraftRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (generatingDrafts.has(id))
    return jsonResponse(
      { error: "Already generating this draft; wait for it to finish." },
      409,
      req,
    );
  generatingDrafts.add(id);
  try {
    return await regenerateDraftInner(req, params);
  } finally {
    generatingDrafts.delete(id);
  }
}

async function regenerateDraftInner(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  // Once sent, last_draft_json IS the frozen sent content — never overwrite it.
  if (row.status === "sent") return jsonResponse({ error: "row already sent" }, 400, req);
  // A send claimed the row but hasn't flipped status yet — refuse to start a
  // regenerate that would race it.
  if (row.send_started_at != null) {
    return jsonResponse({ error: "send in flight, can't regenerate" }, 409, req);
  }

  let target: unknown;
  try {
    target = resolveQueueTarget(row);
  } catch (err) {
    const error =
      err instanceof SyntaxError ? "row payload is not valid JSON" : (err as Error).message;
    return jsonResponse({ error }, 400, req);
  }

  let rotate = false;
  try {
    const raw = await req.text();
    const options: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error();
    const value = (options as { rotateAngle?: unknown }).rotateAngle;
    if (value !== undefined && typeof value !== "boolean") throw new Error();
    rotate = value === true;
  } catch {
    return jsonResponse({ error: "rotateAngle must be a boolean" }, 400, req);
  }
  let previous: Partial<LastDraft> = {};
  try {
    previous = JSON.parse(row.last_draft_json ?? "{}");
  } catch {
    /* legacy draft */
  }
  if (previous?.sent === true) return jsonResponse({ error: "draft already sent" }, 400, req);
  let angle: LastDraft["angle"];
  try {
    const research =
      row.prospect_id != null ? ledger.getProspectById(row.prospect_id)?.dossier_json : null;
    angle = await draftAngleFor({
      ...(research ? { research } : {}),
      target,
      playName: row.play_name,
      ...(parseDraftAngle(previous?.angle) ? { previous: parseDraftAngle(previous.angle)! } : {}),
      ...(typeof previous?.body === "string" ? { previousBody: previous.body } : {}),
      rotate,
    });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 400, req);
  }

  // The target retains queued prospect facts with current trigger edges.
  const body: RunPlayRequest = {
    dryRun: true,
    targets: [target],
  };

  let drafted: Awaited<ReturnType<typeof dispatchPlay>>;
  try {
    drafted = await dispatchPlay(row.play_name, body, undefined, undefined, angle?.text);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 400, req);
  }
  const draft = drafted[0];
  if (!draft || !draft.body.trim() || draft.flags.some((f) => f.startsWith("error:"))) {
    return jsonResponse(
      { error: "Draft generation failed. Your existing draft is unchanged; try again." },
      500,
      req,
    );
  }

  // TOCTOU close: re-read after the multi-second dispatchPlay await — a
  // concurrent send completing mid-LLM-call must not get its canonical sent
  // body/receiptIds overwritten below.
  const fresh = ledger.getQueueRow(id);
  if (!fresh || fresh.status === "sent" || fresh.send_started_at != null) {
    return jsonResponse({ error: "send completed (or started) during regenerate" }, 409, req);
  }

  const out: LastDraft = {
    subject: draft.subject,
    body: draft.body,
    flags: draft.flags,
    sent: false,
    receiptIds: [],
    dryRun: true,
    draftedAt: new Date().toISOString(),
    ...(angle ? { angle } : {}),
    ...(draft.enrichmentFailed ? { enrichmentFailed: true } : {}),
  };
  const saved = ledger.setQueueDraftIfCurrent({
    id,
    previousDraft: row.last_draft_json ?? null,
    previousPayload: row.payload_json,
    draft: out,
  });
  if (!saved)
    return jsonResponse(
      { error: "Draft changed during generation; refresh and try again." },
      409,
      req,
    );
  return jsonResponse(out, 200, req);
}

/**
 * Record that a MANUAL play's draft was sent by hand (e.g. x-amplify-dm: the
 * founder copied the DM text and sent it from the X app). No transport, no
 * receipt — writes the prospect + a step-0 sequence event on the play's manual
 * channel and flips the row to `sent`. Only plays in MANUAL_PLAYS qualify;
 * everything else must go through the real send route.
 */
export async function markSentRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  const manual = MANUAL_PLAYS[row.play_name];
  if (!manual) {
    return jsonResponse(
      { error: `${row.play_name} is not a manual-send play — use send-draft` },
      400,
      req,
    );
  }
  if (row.status === "sent") return jsonResponse({ error: "row already marked sent" }, 400, req);
  // Same review gate as the send path: only an approved row may be recorded
  // as sent — marking a rejected (or never-reviewed) row would silently
  // un-reject it and log outreach to a person the founder killed.
  if (row.status !== "approved") {
    return jsonResponse(
      { error: `row is ${row.status} — approve it before marking sent` },
      400,
      req,
    );
  }
  if (!row.last_draft_json) {
    return jsonResponse({ error: "no draft on this row — drain or regenerate first" }, 400, req);
  }
  let draft: Partial<LastDraft>;
  try {
    draft = JSON.parse(row.last_draft_json) as Partial<LastDraft>;
  } catch {
    return jsonResponse({ error: "stored draft is not valid JSON" }, 400, req);
  }
  const body = typeof draft.body === "string" ? draft.body : "";
  if (!body) return jsonResponse({ error: "stored draft is empty" }, 400, req);

  let payload: Record<string, unknown> = {};
  try {
    const p = JSON.parse(row.payload_json);
    if (p && typeof p === "object") payload = p as Record<string, unknown>;
  } catch {
    // tolerated — prospect fields below just come up null
  }
  const pstr = (k: string): string | null => (typeof payload[k] === "string" ? payload[k] : null);
  const twitterUrl = pstr("twitterUrl");

  const prospectId = ledger.upsertProspect({
    name: pstr("name"),
    email: null,
    linkedin_url: twitterUrl,
    source: row.play_name,
    source_profile_url: twitterUrl,
  });
  ledger.recordSequenceEvent({
    prospectId,
    playName: row.play_name,
    stepIndex: 0,
    channel: manual.channel,
    status: "sent",
    metadata: { body, ...playMetadata(row.play_name, payload) },
  });
  try {
    ledger.setQueueProspectId(row.id, prospectId);
  } catch {
    // best-effort backfill — the marked send is already recorded
  }
  // A per-row human action (manually sent via another channel).
  ledger.setQueueStatus({ id: row.id, status: "sent", decidedBy: "human" });
  return jsonResponse({ ok: true, prospectId }, 200, req);
}

/**
 * Send the row's already-reviewed draft VERBATIM (no LLM re-roll) via
 * `sendDraftedEmail`, then enroll the cadence and flip the row to `sent`.
 * Requires a clean (lint-flag-free), not-yet-sent draft.
 */
export async function sendDraftRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  // Server is draining for shutdown — don't start a new send.
  if (isDraining()) {
    return jsonResponse({ error: "server restarting — retry in a moment" }, 503, req);
  }
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  if (row.status === "sent") return jsonResponse({ error: "row already sent" }, 400, req);
  if (row.status !== "approved") {
    return jsonResponse({ error: `row is ${row.status}; approve it before sending` }, 409, req);
  }
  if (!row.last_draft_json) {
    return jsonResponse({ error: "no draft to send — regenerate a draft first" }, 400, req);
  }

  let parsed: Partial<LastDraft>;
  try {
    parsed = JSON.parse(row.last_draft_json) as Partial<LastDraft>;
  } catch {
    return jsonResponse({ error: "stored draft is not valid JSON" }, 400, req);
  }
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  const flags = Array.isArray(parsed.flags) ? parsed.flags : [];
  if (!subject || !body) {
    return jsonResponse({ error: "stored draft is empty — regenerate first" }, 400, req);
  }
  // Soft review flags are founder-overridable here — this IS the
  // review-then-send step. Only blocking flags refuse a manual send.
  if (blockingFlags(flags).length > 0) {
    return jsonResponse(
      { error: "draft has lint flags — regenerate to clear them before sending" },
      400,
      req,
    );
  }
  if (parsed.sent === true) return jsonResponse({ error: "draft already sent" }, 400, req);

  // Atomic claim of the sending marker. Stale cutoff matches the cadence-send
  // window (5 min); past that, a fresh click can reclaim. Cleared on success
  // by setQueueStatus('sent'); explicitly in the catch on failure.
  const QUEUE_SEND_MAX_AGE_MS = 5 * 60 * 1000;
  const claimed = ledger.claimQueueSendingMarker({
    id,
    startedAtIso: new Date().toISOString(),
    staleCutoffIso: new Date(Date.now() - QUEUE_SEND_MAX_AGE_MS).toISOString(),
  });
  if (!claimed) {
    return jsonResponse(
      { error: "already sending — wait for the in-flight send to complete" },
      409,
      req,
    );
  }
  // The claim itself requires status='approved'. Re-read so an expiry that
  // raced immediately after the claim is observed before provider dispatch.
  const claimedRow = ledger.getQueueRow(id);
  if (claimedRow?.status !== "approved") {
    ledger.clearQueueSendingMarker(id);
    return jsonResponse({ error: "row changed while sending; refresh and retry" }, 409, req);
  }

  let payload: Record<string, unknown> = {};
  try {
    const p = JSON.parse(row.payload_json);
    if (p && typeof p === "object") payload = p as Record<string, unknown>;
  } catch {
    // fall through — handled by the missing-email check below
  }
  const str = (k: string): string | null => (typeof payload[k] === "string" ? payload[k] : null);
  const email = str("email") ?? str("founderEmail");
  if (!email) return jsonResponse({ error: "row has no recipient email" }, 400, req);

  // Exactly one telemetry event per send attempt; declared after pre-send
  // validation so bad-request returns don't count as executions.
  const t0 = performance.now();
  const done = (outcome: TelemetryOutcome, res: Response): Response => {
    void reportServerExecution("server.queue.send", {
      outcome,
      durationMs: performance.now() - t0,
    });
    return res;
  };

  // sendDraftedEmail pushes dedup outcomes here — distinguishes a deliberate
  // skip from a genuine send failure below.
  const sendFlags: string[] = [];
  let result: Awaited<ReturnType<typeof sendDraftedEmail>>;
  try {
    result = await sendDraftedEmail({
      playName: row.play_name,
      to: email,
      draft: { subject, body },
      flags: sendFlags,
      prospectMeta: {
        businessAddress: extractBusinessAddress(payload),
        businessAddressSource: str("businessAddressSource") ?? row.source,
        name: str("name") ?? str("founderName"),
        email,
        company: str("company"),
        // Falls back to twitter/github URL — the column is the de-facto
        // social-profile URL (mirrors the play's own prospectMeta).
        linkedin_url: str("linkedinUrl") ?? str("twitterUrl") ?? str("githubUrl"),
        phone: str("phone"),
        source: row.play_name,
        // Read generically so any finder that sets it gets it persisted.
        source_profile_url: str("sourceProfileUrl") ?? str("githubUrl") ?? str("twitterUrl"),
        // Stamped on the payload by the person-level ICP gate in the finders.
        title: str("title"),
      },
      // The verdict from that same gate. Read generically, like `title`, so
      // approving a row on /queue enforces and records it exactly as an
      // unattended play run does.
      ...(str("icpVerdict") === "pass" ||
      str("icpVerdict") === "reject" ||
      str("icpVerdict") === "unclear"
        ? {
            icp: {
              verdict: str("icpVerdict") as "pass" | "reject" | "unclear",
              reason: str("icpVerdictReason"),
            },
          }
        : {}),
      // The play's evidence metadata (`repo`, `eventTitle`, `vendorStack`, …)
      // MUST be included — step-0 rows without their evidence key silently
      // break everything downstream that reads it.
      metadata: playMetadata(row.play_name, payload),
      dryRun: false,
      // This route IS the review-then-send override for `contacted-elsewhere`.
      allowContactedElsewhere: true,
    });
  } catch (err) {
    // Release the marker so a retry needn't wait for the cold-boot sweep.
    try {
      ledger.clearQueueSendingMarker(id);
    } catch {
      /* sweeper safety net */
    }
    // Daily caps exhausted — not a failure; row stays approved.
    if (isSendDeferred(err)) {
      return done("ok", jsonResponse({ error: (err as Error).message, deferred: true }, 429, req));
    }
    // A race with a touch recorded mid-send is a hold, not a failure.
    if (isRecentlyContacted(err)) {
      return done("ok", jsonResponse({ error: (err as Error).message, held: true }, 409, req));
    }
    // The 400 body carries only the SDK's generic message; log the status +
    // response body so the real reason is recoverable.
    logTargetError({ playName: row.play_name, to: email, err });
    return done(
      "error",
      jsonResponse({ error: (err as Error).message ?? "send failed" }, 400, req),
    );
  }
  if (!result.sent) {
    try {
      ledger.clearQueueSendingMarker(id);
    } catch {
      /* sweeper safety net */
    }
    // Deliberate dedup skip: mark the row rejected with the reason so it
    // leaves the actionable queue instead of inviting endless re-clicks.
    const dedup = sendFlags.find((f) => f === "already-contacted" || f === "already-enrolled");
    if (dedup) {
      const reason =
        dedup === "already-contacted"
          ? "already contacted via another play"
          : "already sent this play";
      ledger.setQueueStatus({ id, status: "rejected", notes: `auto: ${reason} — not re-sent` });
      return done(
        "ok",
        jsonResponse({ error: `${reason} — not re-sent`, skipped: true, reason: dedup }, 409, req),
      );
    }
    return done("error", jsonResponse({ error: "send did not complete" }, 500, req));
  }

  const prospect = ledger.findProspectByEmail(email);
  if (prospect) enrollInCadence({ prospectId: prospect.id, playName: row.play_name });
  // The human read this draft and clicked Send — a per-row judgment.
  ledger.setQueueStatus({ id, status: "sent", decidedBy: "human" });
  ledger.setQueueDraft({
    id,
    draft: {
      subject,
      body,
      flags: [],
      sent: true,
      receiptIds: result.receiptIds,
      dryRun: false,
      ...(parseDraftAngle(parsed.angle) ? { angle: parseDraftAngle(parsed.angle)! } : {}),
    },
  });

  return done("ok", jsonResponse({ sent: true, receiptIds: result.receiptIds }, 200, req));
}

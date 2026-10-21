import {
  abortRun,
  cancelReasonOf,
  getLedger,
  isRunCancelled,
  logEvent,
  registerRunController,
  releaseRunController,
  type TelemetryOutcome,
} from "@oneshot-gtm/core";
import { PLAYS, verifyAndFilterTargets } from "@oneshot-gtm/plays";
import { backfillProspectId, storeDraftOffer } from "@oneshot-gtm/find";
import {
  isRunnablePlay,
  type CancelRunResponse,
  type RunPlayEvent,
  type RunPlayRequest,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { reportServerExecution } from "../telemetry.ts";
import { dispatchPlay, type DraftedView } from "./_play-dispatch.ts";

export async function runPlay(req: Request, params: Record<string, string>): Promise<Response> {
  const playName = params["playName"] ?? "";
  if (!isRunnablePlay(playName)) {
    return jsonResponse(
      { error: `play '${playName}' is not exposed in the UI; use the CLI` },
      400,
      req,
    );
  }

  let body: RunPlayRequest;
  try {
    body = (await req.json()) as RunPlayRequest;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }

  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return jsonResponse({ error: "targets must be a non-empty array" }, 400, req);
  }
  body = restoreQueueObjects(playName, body);

  const mismatched = mismatchedQueueTargets(playName, body);
  if (mismatched.length > 0) {
    return jsonResponse(
      {
        error: `target ${mismatched.map((i) => i + 1).join(", ")} does not match the queue row its key names. Reload the queue rows and run again.`,
      },
      400,
      req,
    );
  }

  // The queue rows a batch was loaded from, by their dedupe keys: each row's
  // source names the trigger whose settings apply to that target (the
  // multiplier play's `memberOffer`); null for a manual row.
  const queueSources = queueSourcesFor(playName, body);
  // The play's own refusal, made before the route's paid verification below:
  // a multiplier run without a member offer bills nothing, not even the check.
  try {
    PLAYS[playName]?.preflight?.({ targets: body.targets, queueSources });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 400, req);
  }

  // Create a runs row up-front so the UI gets a runId and can resume on
  // nav-back; every SSE event below is also appended to events_json.
  // Cold-boot sweep flips any stranded 'running' rows to 'interrupted'.
  const { runId, startedAt } = getLedger().createRun({
    playName,
    dryRun: body.dryRun,
    targets: body.targets,
    dedupeKeys: body.dedupeKeys,
  });
  // Emails that actually sent, for the /cadences?sinceRun=N deep-link.
  const sentEmails: string[] = [];

  // The run's cancellation signal. Two things can fire it: the client going
  // away (below) and POST /api/run/:runId/cancel, which reaches this
  // controller through the process-local registry. Everything downstream:
  // verify, every play, every paid call: reads the same signal, so an abort
  // stops the spend instead of merely abandoning the stream.
  const runAbort = new AbortController();
  registerRunController(runId, runAbort);
  const abortOnce = (reason: string): void => {
    if (!runAbort.signal.aborted) runAbort.abort(reason);
  };
  // Bun aborts `req.signal` when the client disconnects. Belt and braces with
  // the stream's own `cancel()` below: between them they cover a closed tab, a
  // navigation, and a reader that simply stops pulling.
  req.signal.addEventListener("abort", () => abortOnce("client disconnected"), { once: true });
  if (req.signal.aborted) abortOnce("client disconnected");

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      abortOnce("client disconnected");
    },
    async start(controller) {
      const encoder = new TextEncoder();
      const ledger = getLedger();
      // Telemetry bookkeeping for this run: emitted once in `finally`.
      const t0 = performance.now();
      let runOutcome: TelemetryOutcome = "ok";
      let fromQueue = false;
      // Hoisted out of the try so the cancel path can report what the run got
      // through before the abort. The `cancelled` frame carries the same
      // counters `done` would have.
      let sentCount = 0;
      let draftedCount = 0;
      // Set once the run reached a terminal state of its own. A `done` frame
      // or a real error. The `finally` needs to tell "the run ended, then the
      // client left" from "the client left, so the run ended". Only the
      // second is a cancellation.
      let finished = false;
      // Set once the terminal ledger write happened. Past that point a send
      // reported by a straggler worker has to be written again (see below).
      let terminalWritten = false;
      // Non-null once the run is known to have been cancelled; carries the
      // reason that gets persisted on the row.
      let cancelledReason: string | null = null;
      const send = (event: RunPlayEvent): void => {
        // Persist FIRST. The resume view needs every event even after a
        // client disconnect. SSE write second; swallow if the client is gone.
        try {
          ledger.appendRunEvent({ runId, event });
        } catch {
          // ledger write failing is the sweeper's problem; keep streaming.
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client gone: ignore
        }
      };

      // First frame: tell the UI its runId so it can switch to progress mode.
      send({ kind: "runStarted", runId, startedAt });

      const indexToDedupeKey = new Map<number, string>();
      let verify: Awaited<ReturnType<typeof verifyAndFilterTargets>> = {
        verified: [],
        dropped: [],
        receiptIds: [],
        costUsd: 0,
      };
      let drafted: DraftedView[] = [];

      try {
        // Verify emails BEFORE dispatch so undeliverable rows are dropped
        // before LLM spend. Queue-sourced rows were already verified at
        // finder-enqueue time, so only manual rows in a mixed batch are sent
        // through verification.
        const inputCount = body.targets.length;
        const hasAlignedDedupeKeys =
          Array.isArray(body.dedupeKeys) && body.dedupeKeys.length === body.targets.length;
        const queueIndexes = new Set<number>();
        const manualTargets = body.targets.filter((_target, index) => {
          const dedupeKey = hasAlignedDedupeKeys ? body.dedupeKeys?.[index] : null;
          const isQueueTarget = typeof dedupeKey === "string" && dedupeKey.length > 0;
          if (isQueueTarget) queueIndexes.add(index);
          return !isQueueTarget;
        });
        fromQueue = queueIndexes.size > 0;

        if (manualTargets.length > 0 && playName !== "community-reply") {
          send({ kind: "stage", stage: "verifying" });
          const manualVerify = await verifyAndFilterTargets(
            manualTargets as Array<{ email?: string; founderEmail?: string }>,
            (t) => t.email ?? t.founderEmail ?? null,
            { playName, dryRun: body.dryRun, signal: runAbort.signal },
          );
          const verifiedManualEmails = new Set(
            manualVerify.verified.map((target) =>
              (target.email ?? target.founderEmail ?? "").trim().toLowerCase(),
            ),
          );
          verify = {
            ...manualVerify,
            verified: body.targets.filter((target, index) => {
              if (queueIndexes.has(index)) return true;
              const manualTarget = target as { email?: string; founderEmail?: string };
              const email = (manualTarget.email ?? manualTarget.founderEmail ?? "")
                .trim()
                .toLowerCase();
              return verifiedManualEmails.has(email);
            }),
          };
        } else {
          verify = { verified: body.targets, dropped: [], receiptIds: [], costUsd: 0 };
        }
        // Draft indexes are relative to the verified array. Rebuild the queue
        // mapping after verification so a dropped manual row in a mixed batch
        // cannot shift a later queue draft onto the wrong dedupe key.
        if (Array.isArray(body.dedupeKeys) && body.dedupeKeys.length === body.targets.length) {
          const originalIndex = new Map(body.targets.map((target, index) => [target, index]));
          verify.verified.forEach((target, index) => {
            const dedupeKey = body.dedupeKeys?.[originalIndex.get(target) ?? -1];
            if (dedupeKey) indexToDedupeKey.set(index, dedupeKey);
          });
        }
        if (verify.dropped.length > 0) {
          send({
            kind: "verify",
            total: body.targets.length,
            verified: verify.verified.length,
            dropped: verify.dropped.map((d) => ({
              email: d.email,
              reason: d.reason,
              index: d.index,
            })),
          });
        }
        // If verify dropped every target, skip dispatch entirely. The play
        // could throw an irrelevant pre-check error on an empty array.
        if (verify.verified.length === 0 && inputCount > 0) {
          if (runAbort.signal.aborted) {
            cancelledReason = cancelReasonOf(runAbort.signal);
            return;
          }
          send({ kind: "done", total: 0, sent: 0 });
          finished = true;
          return;
        }
        const filteredBody: RunPlayRequest = { ...body, targets: verify.verified };
        // The queue sources re-aligned to the verified rows, handed to the
        // play only when the batch has queue rows at all.
        const originalIndexOf = new Map(body.targets.map((target, index) => [target, index]));
        const verifiedSources = queueSources.some((source) => source !== null)
          ? verify.verified.map((target) => queueSources[originalIndexOf.get(target) ?? -1] ?? null)
          : undefined;

        send({ kind: "stage", stage: body.dryRun ? "drafting" : "drafting + sending" });
        // Per-target callback: fires draft/send events live so counters tick
        // per target instead of jumping at the end.
        drafted = await dispatchPlay(
          playName,
          filteredBody,
          (index, d) => {
            // dispatchPlay rejects on cancellation, so its returned batch is
            // unavailable. Retain completed drafts as they arrive.
            drafted[index] = d;
            draftedCount++;
            send({ kind: "draft", index, subject: d.subject, body: d.body, flags: d.flags });
            // `send` means the email left: the page badges the row "sent",
            // prunes it from the form, and the run's sent_count counts it.
            // Key it on `d.sent`, never on receipts: drafting alone bills
            // (profile enrichment, research), so a dry run carries receipts too.
            if (d.sent) {
              send({ kind: "send", index, receiptIds: d.receiptIds });
              sentCount++;
              // Recover the email for the /cadences?sinceRun resolution.
              const t = verify.verified[index] as
                | { email?: string; founderEmail?: string }
                | undefined;
              const email = t?.email ?? t?.founderEmail;
              if (!email) return;
              sentEmails.push(email);
              // A cancellation rejects the play's Promise.all at once, but its
              // sibling workers can still be inside sendDraftedEmail. They
              // report here AFTER the terminal row was written. That email did
              // leave and did enrol in the cadence, so re-write the list or
              // /cadences?sinceRun silently omits its recipient.
              if (terminalWritten) {
                try {
                  ledger.setRunSentEmails({ runId, sentEmails });
                } catch {
                  // ledger write failing is the sweeper's problem
                }
              }
            }
          },
          runAbort.signal,
          undefined,
          undefined,
          verifiedSources,
        );
        send({ kind: "done", total: drafted.length, sent: sentCount });
        finished = true;
      } catch (err) {
        // A cancellation is not a failure: the run was told to stop, and every
        // target behind the abort point billed nothing. Handled before the
        // error path so it never lands as an `error` frame or an `error`
        // telemetry outcome. The message carries the phase that was about to
        // bill ("show-hn send: client disconnected"), which is exactly what
        // the row's reason should say.
        if (isRunCancelled(err)) {
          cancelledReason = (err as Error).message || cancelReasonOf(runAbort.signal);
          logEvent(
            "run.cancelled",
            {
              play: playName,
              run_id: runId,
              reason_120: cancelledReason.slice(0, 120),
              drafted: draftedCount,
              sent: sentCount,
            },
            "warn",
          );
          // fall through to finally block for persistence instead of returning early
        } else {
          runOutcome = "error";
          // The run ended on its own terms, badly, not because the client left.
          // Mark it settled so a disconnect that follows (or caused nothing but
          // an abort on the way out) can't relabel a real failure a cancellation.
          finished = true;
          // Log the full error server-side. The SSE event only carries a short
          // message, and the SDK's generic "Tool request failed" is useless
          // without status/body/stack.
          const e = err as Error & {
            cause?: unknown;
            statusCode?: number;
            responseBody?: string;
          };
          const causeMsg =
            e?.cause instanceof Error ? e.cause.message : e?.cause ? String(e.cause) : null;
          logEvent(
            "run.pipeline_error",
            {
              play: playName,
              message_200: (e?.message ?? "").slice(0, 200),
              // SDK ToolError carries the failing call's HTTP status + body.
              status_code: typeof e?.statusCode === "number" ? e.statusCode : null,
              response_body_400:
                typeof e?.responseBody === "string" ? e.responseBody.slice(0, 400) : null,
              cause_200: causeMsg ? causeMsg.slice(0, 200) : null,
              stack_300: (e?.stack ?? "").slice(0, 300),
            },
            "error",
          );
          // Surface the real reason to the UI from the response body
          // (e.g. {"error":"domain_not_owned"}).
          let uiMessage = e?.message ?? "run failed";
          if (typeof e?.statusCode === "number") {
            let detail = "";
            try {
              const parsed = JSON.parse(e.responseBody ?? "") as {
                message?: string;
                error?: string;
              };
              detail = parsed.message ?? parsed.error ?? "";
            } catch {
              detail = (e.responseBody ?? "").slice(0, 160);
            }
            uiMessage = `${uiMessage} (HTTP ${e.statusCode})${detail ? ` — ${detail}` : ""}`;
          }
          send({ kind: "error", index: -1, message: uiMessage });
        }
      } finally {
        // Persist drafts to their originating queue rows for /queue review.
        // Best-effort. A SQLite hiccup here must not surface to the user.
        if (indexToDedupeKey.size > 0) {
          try {
            persistDraftsToQueue({
              playName,
              drafted,
              dryRun: body.dryRun,
              indexToDedupeKey,
            });
          } catch (err) {
            // Guard setup as well as individual writes so terminal status,
            // cleanup, and telemetry still happen if ledger access fails.
            logEvent(
              "error.swallowed",
              {
                kind: "run.persistDraftsToQueue",
                play: playName,
                message_120: ((err as Error).message ?? "").slice(0, 120),
              },
              "warn",
            );
          }
        }

        // The abort can also land without anything throwing. A play that
        // never reached a guarded boundary, or the last target finishing
        // between the abort and the next check. An aborted run that never
        // emitted `done` is a cancellation too; one that did is genuinely
        // finished and stays `done` no matter when the client left.
        if (!cancelledReason && !finished && runAbort.signal.aborted) {
          cancelledReason = cancelReasonOf(runAbort.signal);
        }
        if (cancelledReason) {
          // Terminal frame: same counters `done` would have carried, so a
          // resumed view renders what the run got through before the stop.
          send({
            kind: "cancelled",
            reason: cancelledReason,
            total: draftedCount,
            sent: sentCount,
          });
        }
        // Flip the runs row to a terminal state regardless of
        // success/failure/cancel so the cold-boot sweep never sees a false
        // 'running'. `cancelRun` CASes on 'running', so it is a no-op when the
        // cancel route already wrote the row.
        try {
          if (cancelledReason) {
            getLedger().cancelRun({ runId, reason: cancelledReason, sentEmails });
          } else {
            getLedger().markRunComplete({ runId, status: "done", sentEmails });
          }
        } catch {
          // sweeper safety net
        }
        // Any send reported from here on is a straggler and writes its own row
        // update. The array captured above is already in the database.
        terminalWritten = true;
        // Release BEFORE closing the stream: past here there is nothing left
        // to abort, and a retained entry would leak a controller per run and
        // let a later cancel "succeed" against a run that already ended.
        releaseRunController(runId);
        try {
          controller.close();
        } catch {
          // already closed (client disconnected): ignore
        }
        const flags: string[] = [];
        if (body.dryRun) flags.push("dry-run");
        if (fromQueue) flags.push("from-queue");
        if (cancelledReason) flags.push("cancelled");
        void reportServerExecution(`server.run.${playName}`, {
          outcome: runOutcome,
          durationMs: performance.now() - t0,
          flags,
        });
      }
    },
  });

  // Loopback-only CORS for SSE: mirror loopback origins, omit the header
  // otherwise (the outer fetch handler already enforces a loopback Host).
  const origin = req.headers.get("origin") ?? "";
  const isLoopback = isLoopbackOrigin(origin);
  const sseHeaders: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  };
  if (isLoopback) {
    sseHeaders["Access-Control-Allow-Origin"] = origin || "http://127.0.0.1";
    sseHeaders["Vary"] = "Origin";
  }

  return new Response(stream, {
    status: 200,
    headers: sseHeaders,
  });
}

/** Accept absent Origin (same-origin/non-browser clients) or an exact HTTP loopback host. */
function isLoopbackOrigin(origin: string): boolean {
  if (origin === "") return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

/** Cap on the caller-supplied reason so a stray body can't bloat the row. */
const MAX_CANCEL_REASON = 200;
const DEFAULT_UI_CANCEL_REASON = "cancelled by user";

/**
 * `POST /api/run/:runId/cancel`: stop an in-flight run.
 *
 * Two independent halves, because a `running` row and a live handler are not
 * the same thing:
 *  - `abortRun` fires the AbortController the SSE handler registered, which is
 *    what actually stops the spend: every play checks the signal before each
 *    paid call, so nothing bills past the next boundary.
 *  - the ledger write makes the row terminal now rather than whenever the
 *    handler unwinds, and covers the orphan case, where the run's process is
 *    gone and no controller will ever unwind. `cancelRun` CASes on 'running',
 *    so the handler's own write later is a harmless no-op.
 *
 * Cancelling an already-terminal run is a 200 no-op, not an error: the stop
 * button races the run's own completion, and losing that race is not a fault.
 */
export async function cancelRunRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  // Simple CSRF check for this state-changing POST. The dashboard sends no
  // body for a cancel, making it a simple request that CORS preflight does not
  // protect.
  const origin = req.headers.get("origin") ?? "";
  const isLoopback = isLoopbackOrigin(origin);
  if (!isLoopback) {
    return jsonResponse({ error: "cross-origin cancellation rejected" }, 403, req);
  }

  const rawRunId = params["runId"] ?? "";
  if (!/^\d+$/.test(rawRunId)) return jsonResponse({ error: "bad run id" }, 400, req);
  const runId = Number.parseInt(rawRunId, 10);
  if (!Number.isFinite(runId)) return jsonResponse({ error: "bad run id" }, 400, req);

  // Body is optional. The dashboard's stop button sends none.
  let reason = DEFAULT_UI_CANCEL_REASON;
  try {
    const body = (await req.json()) as { reason?: unknown } | null;
    if (body && typeof body.reason === "string" && body.reason.trim().length > 0) {
      reason = body.reason.trim().slice(0, MAX_CANCEL_REASON);
    }
  } catch {
    // no/!JSON body. The default reason stands
  }

  const run = getLedger().getRun(runId);
  if (!run) return jsonResponse({ error: `run #${runId} not found` }, 404, req);
  if (run.status !== "running") {
    const view: CancelRunResponse = {
      runId,
      status: run.status,
      cancelled: false,
      aborted: false,
      reason: run.cancelReason,
    };
    return jsonResponse(view, 200, req);
  }

  // Abort first: the sooner the signal fires, the fewer paid calls get past
  // their boundary. The ledger write follows either way.
  const aborted = abortRun(runId, reason);
  const result = getLedger().cancelRun({ runId, reason });
  logEvent(
    "run.cancel_requested",
    { run_id: runId, play: run.playName, aborted, cancelled: result.cancelled },
    "warn",
  );
  const view: CancelRunResponse = {
    runId,
    status: result.status ?? run.status,
    cancelled: result.cancelled,
    aborted,
    reason,
  };
  return jsonResponse(view, 200, req);
}

/**
 * Write each generated draft to its originating `target_queue` row.
 * Best-effort (logged via `error.swallowed`). Indices match because
 * `verifiedTargets[i]` corresponds to `drafted[i]`.
 */
/** Fields that name exactly one person: when both sides have one, these decide. */
const STRONG_IDENTITY_FIELDS = [
  "email",
  "founderEmail",
  "linkedinUrl",
  "sourceProfileUrl",
  "candidateLogin",
  "twitterUrl",
] as const;
/** Fields two people can share (a name, an organization's site): they decide only when no strong field can. */
const WEAK_IDENTITY_FIELDS = ["name", "founderName", "orgUrl"] as const;
const identityValue = (v: unknown): string =>
  typeof v === "string" ? v.trim().toLowerCase().replace(/\/+$/, "") : "";

/** Whether any field agrees, and whether any could be compared at all. */
function compareFields(
  fields: readonly string[],
  target: Record<string, unknown>,
  payload: Record<string, unknown>,
): { agrees: boolean; compared: boolean } {
  let compared = false;
  for (const field of fields) {
    const a = identityValue(target[field]);
    const b = identityValue(payload[field]);
    if (!a || !b) continue;
    if (a === b) return { agrees: true, compared: true };
    compared = true;
  }
  return { agrees: false, compared };
}

/**
 * Whether a target is the person (or organization) of the queue row its
 * dedupe key names. The run grid is editable, so one corrected field is not a
 * mismatch while another identifier still agrees. A strong identifier (email,
 * profile URL, login) decides when both sides have one; a name or an
 * organization's site decides only when none can be compared; a pair with
 * nothing to compare belongs. A different organization never does: the
 * organization is what a multiplier row pitches. Exported for its test.
 */
export function targetMatchesQueueRow(
  target: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  const org = [identityValue(target["organization"]), identityValue(payload["organization"])];
  if (org[0] && org[1] && org[0] !== org[1]) return false;
  const strong = compareFields(STRONG_IDENTITY_FIELDS, target, payload);
  if (strong.compared) return strong.agrees;
  const weak = compareFields(WEAK_IDENTITY_FIELDS, target, payload);
  return weak.agrees || !weak.compared;
}

/**
 * Indexes of targets paired with a dedupe key whose queue row is someone
 * else. The row's source decides the trigger settings a target is pitched
 * with, and queue rows skip the route's email verification, so a misaligned
 * pair is refused rather than run. Exported for its test.
 */
export function mismatchedQueueTargets(playName: string, body: RunPlayRequest): number[] {
  const keys =
    Array.isArray(body.dedupeKeys) && body.dedupeKeys.length === body.targets.length
      ? body.dedupeKeys
      : null;
  if (!keys) return [];
  const ledger = getLedger();
  const out: number[] = [];
  keys.forEach((key, i) => {
    if (typeof key !== "string" || key.length === 0) return;
    let payload: Record<string, unknown> | null = null;
    try {
      const row = ledger.getQueueRowByDedupe(playName, key);
      payload = row ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    const target = body.targets[i] as Record<string, unknown> | null | undefined;
    if (payload && target && typeof target === "object" && !targetMatchesQueueRow(target, payload))
      out.push(i);
  });
  return out;
}

/**
 * Per target, the `source` of the queue row its dedupe key names (the row the
 * UI loaded it from), null for a manual row or a key no row matches. Exported
 * for its test.
 */
export function queueSourcesFor(playName: string, body: RunPlayRequest): Array<string | null> {
  const keys =
    Array.isArray(body.dedupeKeys) && body.dedupeKeys.length === body.targets.length
      ? body.dedupeKeys
      : null;
  if (!keys) return body.targets.map(() => null);
  const ledger = getLedger();
  return keys.map((key) => {
    if (typeof key !== "string" || key.length === 0) return null;
    try {
      return ledger.getQueueRowByDedupe(playName, key)?.source ?? null;
    } catch {
      return null;
    }
  });
}

/** A JSON object or array: what a queue payload field holds that the run page edits as text. */
function isJsonContainer(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/**
 * The /run page edits every target field as text, so a queue row's object
 * fields (its offer and ranked offers, its person and firm research) arrive
 * as JSON strings. The play reads those as no offer and no research: it
 * would write a fresh offer over the founder's and draft without the
 * research. For each target whose dedupe key names a queue row, every field
 * the row stores as an object or array and the target carries as a string is
 * parsed back; text that no longer parses as one falls back to the row's own
 * value. Text fields, and fields the target dropped, are left as sent.
 * Exported for its test.
 */
export function restoreQueueObjects(playName: string, body: RunPlayRequest): RunPlayRequest {
  const keys =
    Array.isArray(body.dedupeKeys) && body.dedupeKeys.length === body.targets.length
      ? body.dedupeKeys
      : null;
  if (!keys) return body;
  const ledger = getLedger();
  let changed = false;
  const targets = body.targets.map((target, i) => {
    const key = keys[i];
    if (typeof key !== "string" || key.length === 0) return target;
    if (!target || typeof target !== "object" || Array.isArray(target)) return target;
    let payload: Record<string, unknown> | null = null;
    try {
      const row = ledger.getQueueRowByDedupe(playName, key);
      const parsed: unknown = row ? JSON.parse(row.payload_json) : null;
      payload = isJsonContainer(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    if (!payload) return target;
    const t = target as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [field, stored] of Object.entries(payload)) {
      const sent = t[field];
      if (!isJsonContainer(stored) || typeof sent !== "string") continue;
      let value: unknown = stored;
      try {
        const parsed: unknown = JSON.parse(sent);
        if (isJsonContainer(parsed) && Array.isArray(parsed) === Array.isArray(stored)) {
          value = parsed;
        }
      } catch {
        // Not JSON any more: the row's own value stands.
      }
      out ??= { ...t };
      out[field] = value;
    }
    if (!out) return target;
    changed = true;
    return out;
  });
  return changed ? { ...body, targets } : body;
}

/** Exported for its test. */
export function persistDraftsToQueue(input: {
  playName: string;
  drafted: DraftedView[];
  dryRun: boolean;
  indexToDedupeKey: ReadonlyMap<number, string>;
}): void {
  const ledger = getLedger();
  for (let i = 0; i < input.drafted.length; i++) {
    const draft = input.drafted[i];
    if (!draft) continue;
    // The target index is now stored in originalTargetIndex to map back safely
    const dedupeKey = input.indexToDedupeKey.get(draft.originalTargetIndex ?? i);
    if (!dedupeKey) continue;
    try {
      const row = ledger.getQueueRowByDedupe(input.playName, dedupeKey);
      if (!row) continue;
      // An offer the run wrote (the row had none current) goes on the row
      // with the draft built on it, before a send flips the row: the queue,
      // a later Send of this draft and the sequence then name the same one.
      if (draft.offer && draft.offerCandidates) {
        storeDraftOffer(row, draft.offer, draft.offerCandidates);
      }
      ledger.setQueueDraft({
        id: row.id,
        draft: {
          subject: draft.subject,
          body: draft.body,
          flags: draft.flags,
          sent: draft.sent,
          receiptIds: draft.receiptIds,
          dryRun: input.dryRun,
          ...(draft.enrichmentFailed ? { enrichmentFailed: true } : {}),
          ...(draft.angle ? { angle: draft.angle } : {}),
          ...(draft.voiceKey ? { voiceKey: draft.voiceKey } : {}),
          ...(draft.learningKey ? { learningKey: draft.learningKey } : {}),
          ...(draft.formatKey ? { formatKey: draft.formatKey } : {}),
          ...(draft.evidenceClause !== undefined ? { evidenceClause: draft.evidenceClause } : {}),
        },
        // A run's send is not a per-row review: the founder approved the
        // person; the draft went out unseen.
        sentBy: "machine",
      });
      // A real send must leave the approved pool or every drain re-loads the
      // same row forever. Held drafts and dry-runs intentionally stay approved.
      if (draft.sent && !input.dryRun) {
        ledger.setQueueStatus({ id: row.id, status: "sent" });
        // Link the sent queue row to the prospect created by this send.
        const prospectId = backfillProspectId(row);
        if (prospectId != null) {
          try {
            ledger.setQueueProspectId(row.id, prospectId);
          } catch {
            // Best-effort link. The send is already recorded either way.
          }
        }
      }
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "run.persistDraftsToQueue",
          play: input.playName,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
  }
}

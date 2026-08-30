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
import { verifyAndFilterTargets } from "@oneshot-gtm/plays";
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

  // Create a runs row up-front so the UI gets a runId and can resume on
  // nav-back; every SSE event below is also appended to events_json.
  // Cold-boot sweep flips any stranded 'running' rows to 'interrupted'.
  const { runId, startedAt } = getLedger().createRun({
    playName,
    dryRun: body.dryRun,
    targets: body.targets,
  });
  // Emails that actually sent, for the /cadences?sinceRun=N deep-link.
  const sentEmails: string[] = [];

  // The run's cancellation signal. Two things can fire it: the client going
  // away (below) and POST /api/run/:runId/cancel, which reaches this
  // controller through the process-local registry. Everything downstream —
  // verify, every play, every paid call — reads the same signal, so an abort
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

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      abortOnce("client disconnected");
    },
    async start(controller) {
      const encoder = new TextEncoder();
      const ledger = getLedger();
      // Telemetry bookkeeping for this run — emitted once in `finally`.
      const t0 = performance.now();
      let runOutcome: TelemetryOutcome = "ok";
      let fromQueue = false;
      // Hoisted out of the try so the cancel path can report what the run got
      // through before the abort — the `cancelled` frame carries the same
      // counters `done` would have.
      let sentCount = 0;
      let draftedCount = 0;
      // Set once the run reached a terminal state of its own — a `done` frame
      // or a real error. The `finally` needs to tell "the run ended, then the
      // client left" from "the client left, so the run ended" — only the
      // second is a cancellation.
      let finished = false;
      // Set once the terminal ledger write happened. Past that point a send
      // reported by a straggler worker has to be written again (see below).
      let terminalWritten = false;
      // Non-null once the run is known to have been cancelled; carries the
      // reason that gets persisted on the row.
      let cancelledReason: string | null = null;
      const send = (event: RunPlayEvent): void => {
        // Persist FIRST — the resume view needs every event even after a
        // client disconnect. SSE write second; swallow if the client is gone.
        try {
          ledger.appendRunEvent({ runId, event });
        } catch {
          // ledger write failing is the sweeper's problem; keep streaming.
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client gone — ignore
        }
      };

      // First frame: tell the UI its runId so it can switch to progress mode.
      send({ kind: "runStarted", runId, startedAt });

      try {
        // Build email → dedupeKey map BEFORE the verify filter drops rows —
        // verify changes target indices but not emails. Manual /run entries
        // omit `dedupeKeys`; the map stays empty and persistence is a no-op.
        const emailToDedupeKey = new Map<string, string>();
        if (body.dedupeKeys && body.dedupeKeys.length === body.targets.length) {
          body.targets.forEach((t, i) => {
            const target = t as { email?: string; founderEmail?: string };
            const email = target.email ?? target.founderEmail;
            const key = body.dedupeKeys?.[i];
            if (email && key) emailToDedupeKey.set(email, key);
          });
        }

        // Verify emails BEFORE dispatch so undeliverable rows are dropped
        // before LLM spend. Skipped on dryRun and for queue-sourced runs
        // (already verified at finder-enqueue time).
        const inputCount = body.targets.length;
        fromQueue =
          Array.isArray(body.dedupeKeys) && body.dedupeKeys.length === body.targets.length;
        let verify: Awaited<ReturnType<typeof verifyAndFilterTargets>>;
        if (fromQueue) {
          verify = { verified: body.targets, dropped: [], receiptIds: [], costUsd: 0 };
        } else {
          send({ kind: "stage", stage: "verifying" });
          verify = await verifyAndFilterTargets(
            body.targets as Array<{ email?: string; founderEmail?: string }>,
            (t) => t.email ?? t.founderEmail ?? null,
            { playName, dryRun: body.dryRun, signal: runAbort.signal },
          );
        }
        if (verify.dropped.length > 0) {
          send({
            kind: "verify",
            total: inputCount,
            verified: verify.verified.length,
            dropped: verify.dropped.map((d) => ({ email: d.email, reason: d.reason })),
          });
        }
        // If verify dropped every target, skip dispatch entirely — the play
        // could throw an irrelevant pre-check error on an empty array.
        if (verify.verified.length === 0 && inputCount > 0) {
          send({ kind: "done", total: 0, sent: 0 });
          finished = true;
          return;
        }
        const filteredBody: RunPlayRequest = { ...body, targets: verify.verified };

        send({ kind: "stage", stage: body.dryRun ? "drafting" : "drafting + sending" });
        // Per-target callback: fires draft/send events live so counters tick
        // per target instead of jumping at the end.
        const drafted = await dispatchPlay(
          playName,
          filteredBody,
          (index, d) => {
            draftedCount++;
            send({ kind: "draft", index, subject: d.subject, body: d.body, flags: d.flags });
            if (d.receiptIds.length > 0) {
              send({ kind: "send", index, receiptIds: d.receiptIds });
            }
            if (d.sent) {
              sentCount++;
              // Recover the email for the /cadences?sinceRun resolution.
              const t = verify.verified[index] as
                | { email?: string; founderEmail?: string }
                | undefined;
              const email = t?.email ?? t?.founderEmail;
              if (!email) return;
              sentEmails.push(email);
              // A cancellation rejects the play's Promise.all at once, but its
              // sibling workers can still be inside sendDraftedEmail — they
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
        );
        send({ kind: "done", total: drafted.length, sent: sentCount });
        finished = true;

        // Persist drafts to their originating queue rows for /queue review.
        // Best-effort — a SQLite hiccup here must not surface to the user.
        if (emailToDedupeKey.size > 0) {
          persistDraftsToQueue({
            playName,
            verifiedTargets: verify.verified as Array<{ email?: string; founderEmail?: string }>,
            drafted,
            dryRun: body.dryRun,
            emailToDedupeKey,
          });
        }
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
          return;
        }
        runOutcome = "error";
        // The run ended on its own terms, badly — not because the client left.
        // Mark it settled so a disconnect that follows (or caused nothing but
        // an abort on the way out) can't relabel a real failure a cancellation.
        finished = true;
        // Log the full error server-side — the SSE event only carries a short
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
      } finally {
        // The abort can also land without anything throwing — a play that
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
        // update — the array captured above is already in the database.
        terminalWritten = true;
        // Release BEFORE closing the stream: past here there is nothing left
        // to abort, and a retained entry would leak a controller per run and
        // let a later cancel "succeed" against a run that already ended.
        releaseRunController(runId);
        try {
          controller.close();
        } catch {
          // already closed (client disconnected) — ignore
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
  const isLoopback =
    origin === "" ||
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://[::1]");
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

/** Cap on the caller-supplied reason so a stray body can't bloat the row. */
const MAX_CANCEL_REASON = 200;
const DEFAULT_UI_CANCEL_REASON = "cancelled by user";

/**
 * `POST /api/run/:runId/cancel` — stop an in-flight run.
 *
 * Two independent halves, because a `running` row and a live handler are not
 * the same thing:
 *  - `abortRun` fires the AbortController the SSE handler registered, which is
 *    what actually stops the spend: every play checks the signal before each
 *    paid call, so nothing bills past the next boundary.
 *  - the ledger write makes the row terminal now rather than whenever the
 *    handler unwinds — and covers the orphan case, where the run's process is
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
  const runId = Number.parseInt(params["runId"] ?? "", 10);
  if (!Number.isFinite(runId)) return jsonResponse({ error: "bad run id" }, 400, req);

  // Body is optional — the dashboard's stop button sends none.
  let reason = DEFAULT_UI_CANCEL_REASON;
  try {
    const body = (await req.json()) as { reason?: unknown } | null;
    if (body && typeof body.reason === "string" && body.reason.trim().length > 0) {
      reason = body.reason.trim().slice(0, MAX_CANCEL_REASON);
    }
  } catch {
    // no/!JSON body — the default reason stands
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
function persistDraftsToQueue(input: {
  playName: string;
  verifiedTargets: Array<{ email?: string; founderEmail?: string }>;
  drafted: DraftedView[];
  dryRun: boolean;
  emailToDedupeKey: Map<string, string>;
}): void {
  const ledger = getLedger();
  for (let i = 0; i < input.drafted.length; i++) {
    const target = input.verifiedTargets[i];
    const draft = input.drafted[i];
    if (!target || !draft) continue;
    const email = target.email ?? target.founderEmail;
    if (!email) continue;
    const dedupeKey = input.emailToDedupeKey.get(email);
    if (!dedupeKey) continue;
    try {
      const row = ledger.getQueueRowByDedupe(input.playName, dedupeKey);
      if (!row) continue;
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
        },
      });
      // A real send must leave the approved pool or every drain re-loads the
      // same row forever. Held drafts and dry-runs intentionally stay approved.
      if (draft.sent && !input.dryRun) {
        ledger.setQueueStatus({ id: row.id, status: "sent" });
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

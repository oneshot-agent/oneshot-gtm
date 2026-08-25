import { getLedger, logEvent, type TelemetryOutcome } from "@oneshot-gtm/core";
import { verifyAndFilterTargets } from "@oneshot-gtm/plays";
import { isRunnablePlay, type RunPlayEvent, type RunPlayRequest } from "@oneshot-gtm/shared-types";
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const ledger = getLedger();
      // Telemetry bookkeeping for this run — emitted once in `finally`.
      const t0 = performance.now();
      let runOutcome: TelemetryOutcome = "ok";
      let fromQueue = false;
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
            { playName, dryRun: body.dryRun },
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
          return;
        }
        const filteredBody: RunPlayRequest = { ...body, targets: verify.verified };

        send({ kind: "stage", stage: body.dryRun ? "drafting" : "drafting + sending" });
        let sentCount = 0;
        // Per-target callback: fires draft/send events live so counters tick
        // per target instead of jumping at the end.
        const drafted = await dispatchPlay(playName, filteredBody, (index, d) => {
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
            if (email) sentEmails.push(email);
          }
        });
        send({ kind: "done", total: drafted.length, sent: sentCount });

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
        runOutcome = "error";
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
        // Flip the runs row to 'done' regardless of success/failure so the
        // cold-boot sweep never sees a false 'running'.
        try {
          getLedger().markRunComplete({ runId, status: "done", sentEmails });
        } catch {
          // sweeper safety net
        }
        try {
          controller.close();
        } catch {
          // already closed (client disconnected) — ignore
        }
        const flags: string[] = [];
        if (body.dryRun) flags.push("dry-run");
        if (fromQueue) flags.push("from-queue");
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

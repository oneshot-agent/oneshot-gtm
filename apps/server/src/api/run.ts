import { getLedger, logEvent } from "@oneshot-gtm/core";
import { verifyAndFilterTargets } from "@oneshot-gtm/plays";
import type { RunPlayEvent, RunPlayRequest } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { dispatchPlay, type DraftedView } from "./_play-dispatch.ts";

const SUPPORTED = new Set([
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
  "competitor-switch",
  "stack-consolidation",
  "repo-interest",
]);

export async function runPlay(req: Request, params: Record<string, string>): Promise<Response> {
  const playName = params["playName"] ?? "";
  if (!SUPPORTED.has(playName)) {
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: RunPlayEvent): void => {
        // The client may disconnect mid-run (closed tab, navigation, or a
        // request timeout) — the controller is then closed and enqueue throws.
        // Swallow it: the server-side work (incl. any real send) still happened
        // and there's nothing to stream to. Avoids a false pipeline_error.
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client gone — ignore
        }
      };

      try {
        // Build email → dedupeKey map BEFORE the verify filter potentially
        // drops rows. The verify pass changes target indices but not target
        // emails, so we can recover the dedupe key per drafted target by
        // looking up the email later. Manual /run entries (no fromQueue)
        // omit `dedupeKeys`; the map stays empty and the persist hook is
        // a no-op.
        const emailToDedupeKey = new Map<string, string>();
        if (body.dedupeKeys && body.dedupeKeys.length === body.targets.length) {
          body.targets.forEach((t, i) => {
            const target = t as { email?: string; founderEmail?: string };
            const email = target.email ?? target.founderEmail;
            const key = body.dedupeKeys?.[i];
            if (email && key) emailToDedupeKey.set(email, key);
          });
        }

        // Verify all target emails BEFORE dispatching to the play, so
        // undeliverable rows are dropped before we spend on LLM drafting.
        // Skipped on dryRun (no real spend during preview), AND skipped for
        // queue-sourced runs (dedupeKeys present) — those rows were already
        // verified at finder-enqueue time, so re-verifying just adds latency.
        // The verify event tells the UI which rows were dropped + why.
        const inputCount = body.targets.length;
        const fromQueue =
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
        // If verify dropped every target, skip dispatch entirely — no point
        // calling the play with an empty array (the play would either
        // return empty drafted[] or throw on a "founder profile incomplete"
        // pre-check that's irrelevant when there's nothing to send).
        if (verify.verified.length === 0 && inputCount > 0) {
          send({ kind: "done", total: 0, sent: 0 });
          return;
        }
        const filteredBody: RunPlayRequest = { ...body, targets: verify.verified };

        send({ kind: "stage", stage: body.dryRun ? "drafting" : "drafting + sending" });
        const drafted = await dispatchPlay(playName, filteredBody);
        let sentCount = 0;
        drafted.forEach((d, index) => {
          send({ kind: "draft", index, subject: d.subject, body: d.body, flags: d.flags });
          if (d.receiptIds.length > 0) {
            send({ kind: "send", index, receiptIds: d.receiptIds });
          }
          if (d.sent) sentCount++;
        });
        send({ kind: "done", total: drafted.length, sent: sentCount });

        // Persist drafts to their originating queue rows so the founder can
        // review subject/body/flags later via /queue. Best-effort — the
        // SSE stream has already finished by here, so a SQLite hiccup
        // shouldn't surface as a user-visible error.
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
        // Log the full error server-side — the SSE error event only carries a
        // short message (e.g. the SDK's generic "Tool request failed"), which
        // is useless for diagnosis. The stack reveals which call failed
        // (sendEmail / enrichProfile / verifyEmail in oneshot.ts).
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
            // OneShot SDK ToolError carries the failing call's HTTP status +
            // server response body — the actual reason, vs the generic message.
            status_code: typeof e?.statusCode === "number" ? e.statusCode : null,
            response_body_400:
              typeof e?.responseBody === "string" ? e.responseBody.slice(0, 400) : null,
            cause_200: causeMsg ? causeMsg.slice(0, 200) : null,
            stack_300: (e?.stack ?? "").slice(0, 300),
          },
          "error",
        );
        // Surface the real reason to the UI. The SDK's bare "Tool request
        // failed" is useless; the server response body carries the actual
        // error (e.g. {"error":"domain_not_owned","message":"…"}).
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
        try {
          controller.close();
        } catch {
          // already closed (client disconnected) — ignore
        }
      }
    },
  });

  // Loopback-only CORS for SSE. The outer fetch handler already enforces
  // a loopback Host check before this runs, so we just mirror the origin
  // when it's loopback and otherwise omit the header (browser refuses
  // cross-origin response reads).
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
 * After the SSE stream completes, write each generated draft to its
 * originating `target_queue` row. Best-effort: a SQL hiccup during
 * persistence is logged via `error.swallowed` and doesn't affect what the
 * UI already saw on the wire. Indices match because `verifiedTargets[i]`
 * corresponds to `drafted[i]` (both come from the same dispatch).
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
        },
      });
      // A real, successful send must leave the approved pool — otherwise the
      // row stays `approved` and every subsequent drain (esp. limit 1) re-loads
      // the same first approved target forever. Held drafts (lint flags →
      // sent:false) and dry-run previews intentionally stay approved.
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

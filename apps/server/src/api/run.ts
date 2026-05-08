import {
  runAcceleratorBatch,
  runCompetitorSwitch,
  runHiringSignal,
  runJobChange,
  runPodcastGuest,
  runPostFunding,
  runShowHn,
  verifyAndFilterTargets,
  type AcceleratorBatchTarget,
  type CompetitorSwitchTarget,
  type HiringSignalTarget,
  type JobChangeTarget,
  type PodcastGuestTarget,
  type PostFundingTarget,
  type ShowHnTarget,
} from "@oneshot-gtm/plays";
import type { RunPlayEvent, RunPlayRequest } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

const SUPPORTED = new Set([
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
  "competitor-switch",
]);

interface DraftedView {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
}

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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        // Verify all target emails BEFORE dispatching to the play, so
        // undeliverable rows are dropped before we spend on LLM drafting.
        // Skipped on dryRun (no real spend during preview). The verify
        // event tells the UI which rows were dropped + why.
        const inputCount = body.targets.length;
        const verify = await verifyAndFilterTargets(
          body.targets as Array<{ email?: string; founderEmail?: string }>,
          (t) => t.email ?? t.founderEmail ?? null,
          { playName, dryRun: body.dryRun },
        );
        if (verify.dropped.length > 0) {
          send({
            kind: "verify",
            total: inputCount,
            verified: verify.verified.length,
            dropped: verify.dropped.map((d) => ({ email: d.email, reason: d.reason })),
          });
        }
        const filteredBody: RunPlayRequest = { ...body, targets: verify.verified };

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
      } catch (err) {
        send({ kind: "error", index: -1, message: (err as Error).message });
      } finally {
        controller.close();
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

async function dispatchPlay(playName: string, body: RunPlayRequest): Promise<DraftedView[]> {
  switch (playName) {
    case "show-hn": {
      const result = await runShowHn({
        dryRun: body.dryRun,
        targets: body.targets as ShowHnTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "job-change": {
      const result = await runJobChange({
        dryRun: body.dryRun,
        targets: body.targets as JobChangeTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "post-funding": {
      const result = await runPostFunding({
        dryRun: body.dryRun,
        targets: body.targets as PostFundingTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "accelerator-batch": {
      if (!body.senderCohort || body.senderCohort.length === 0) {
        throw new Error("accelerator-batch requires senderCohort");
      }
      const result = await runAcceleratorBatch({
        dryRun: body.dryRun,
        targets: body.targets as AcceleratorBatchTarget[],
        senderCohort: body.senderCohort,
        ...(body.freeForCohortOffer ? { freeForCohortOffer: body.freeForCohortOffer } : {}),
      });
      return result.drafted.map(toDraftedView);
    }
    case "hiring-signal": {
      const result = await runHiringSignal({
        dryRun: body.dryRun,
        targets: body.targets as HiringSignalTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "podcast-guest": {
      const result = await runPodcastGuest({
        dryRun: body.dryRun,
        targets: body.targets as PodcastGuestTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    case "competitor-switch": {
      const result = await runCompetitorSwitch({
        dryRun: body.dryRun,
        targets: body.targets as CompetitorSwitchTarget[],
      });
      return result.drafted.map(toDraftedView);
    }
    default:
      throw new Error(`unsupported play: ${playName}`);
  }
}

function toDraftedView(d: {
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
}): DraftedView {
  return {
    subject: d.subject,
    body: d.body,
    flags: d.flags,
    receiptIds: d.receiptIds,
    sent: d.sent,
  };
}

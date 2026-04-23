import {
  runAcceleratorBatch,
  runJobChange,
  runShowHn,
  type AcceleratorBatchTarget,
  type JobChangeTarget,
  type ShowHnTarget,
} from "@oneshot-gtm/plays";
import type { RunPlayEvent, RunPlayRequest } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

const SUPPORTED = new Set(["show-hn", "job-change", "accelerator-batch"]);

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
        const drafted = await dispatchPlay(playName, body);
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
  if (playName === "show-hn") {
    const result = await runShowHn({
      dryRun: body.dryRun,
      targets: body.targets as ShowHnTarget[],
    });
    return result.drafted.map((d) => ({
      subject: d.subject,
      body: d.body,
      flags: d.flags,
      receiptIds: d.receiptIds,
      sent: d.sent,
    }));
  }
  if (playName === "job-change") {
    const result = await runJobChange({
      dryRun: body.dryRun,
      targets: body.targets as JobChangeTarget[],
    });
    return result.drafted.map((d) => ({
      subject: d.subject,
      body: d.body,
      flags: d.flags,
      receiptIds: d.receiptIds,
      sent: d.sent,
    }));
  }
  if (playName === "accelerator-batch") {
    if (!body.senderCohort || body.senderCohort.length === 0) {
      throw new Error("accelerator-batch requires senderCohort");
    }
    const result = await runAcceleratorBatch({
      dryRun: body.dryRun,
      targets: body.targets as AcceleratorBatchTarget[],
      senderCohort: body.senderCohort,
      ...(body.freeForCohortOffer ? { freeForCohortOffer: body.freeForCohortOffer } : {}),
    });
    return result.drafted.map((d) => ({
      subject: d.subject,
      body: d.body,
      flags: d.flags,
      receiptIds: d.receiptIds,
      sent: d.sent,
    }));
  }
  throw new Error(`unsupported play: ${playName}`);
}

import { getLedger } from "@oneshot-gtm/core";
import type { RunRecord, RunPlayEvent } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * `GET /api/runs/:id` — snapshot of one /run-page dispatch. The UI polls this
 * every 2s while `status === 'running'`, then stops once `status` flips to
 * `done` or `interrupted`. The full events array is returned so the resume
 * view can rebuild per-target rows identically to a live SSE consumer.
 */
export function getRunRoute(req: Request, params: Record<string, string>): Response {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const run = getLedger().getRun(id);
  if (!run) return jsonResponse({ error: `run #${id} not found` }, 404, req);
  // Cast events through unknown → RunPlayEvent[]. Ledger stores them as
  // unknown[] (shape-agnostic); the route is the typed boundary.
  const view: RunRecord = {
    id: run.id,
    playName: run.playName,
    dryRun: run.dryRun,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    targetCount: run.targetCount,
    draftedCount: run.draftedCount,
    sentCount: run.sentCount,
    errorCount: run.errorCount,
    targets: run.targets,
    events: run.events as RunPlayEvent[],
    prospectEmails: run.prospectEmails,
  };
  return jsonResponse(view, 200, req);
}

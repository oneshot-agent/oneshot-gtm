import { createProspectResearchJob, runProspectResearch } from "@oneshot-gtm/plays";
import type { AddProspectRequest, AddProspectResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * POST /api/prospects/add — manual add-prospect from a profile URL.
 *
 * Validates + enqueues a placeholder `profile-intro` queue row synchronously,
 * then kicks off the ~2-5 min dossier research + draft in the background
 * (`void runProspectResearch`) and returns 202 immediately. The drafted row
 * fills in on `/queue` (which polls) when research completes.
 */
export async function addProspectRoute(req: Request): Promise<Response> {
  let body: AddProspectRequest;
  try {
    body = (await req.json()) as AddProspectRequest;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (!body || typeof body.url !== "string" || body.url.trim() === "") {
    return jsonResponse({ error: "url required" }, 400, req);
  }
  const email =
    typeof body.email === "string" && body.email.trim() !== "" ? body.email.trim() : undefined;

  let job: ReturnType<typeof createProspectResearchJob>;
  try {
    job = createProspectResearchJob({ url: body.url, ...(email ? { emailOverride: email } : {}) });
  } catch (err) {
    // parseProfileUrl throws a clear message on bad / unsupported URLs.
    return jsonResponse({ error: (err as Error).message }, 400, req);
  }

  if ("duplicate" in job) {
    const result: AddProspectResult = { queued: false, duplicate: true };
    return jsonResponse(result, 200, req);
  }

  // Fire-and-forget the heavy research + draft. Errors land on the row's notes.
  void runProspectResearch(job.queueId);

  const result: AddProspectResult = { queued: true, queueId: job.queueId };
  return jsonResponse(result, 202, req);
}

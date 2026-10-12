import {
  describeInviteQuota,
  getSharedDb,
  importTouchedProfiles,
  linkedInInviteStatus,
  linkedInOutreachAccount,
  parseTouchedFile,
} from "@oneshot-gtm/core";
import type {
  LinkedInInviteQuotaView,
  LinkedInTouchedImportView,
  LinkedInTouchedView,
} from "@oneshot-gtm/shared-types";
import { callLinkedIn } from "../linkedin-client.ts";
import { jsonResponse } from "../server.ts";

/**
 * GET /api/linkedin/invites: how many LinkedIn invites are left today, for
 * /queue, /cadences and the Setup LinkedIn card. `connected: false` when no
 * account is connected; the account side is null when OneShot can't be read.
 */
export async function linkedInInviteQuotaRoute(req: Request): Promise<Response> {
  const account = linkedInOutreachAccount();
  if (!account) {
    const view: LinkedInInviteQuotaView = {
      connected: false,
      perDay: null,
      used: 0,
      left: null,
      accountLeft: null,
      text: null,
    };
    return jsonResponse(view, 200, req);
  }
  const status = await linkedInInviteStatus(account.accountId, () =>
    callLinkedIn(account.workspace, { kind: "account", accountId: account.accountId }),
  );
  const view: LinkedInInviteQuotaView = {
    connected: true,
    perDay: status.perDay,
    used: status.used,
    left: status.left,
    accountLeft: status.accountLeft,
    text: describeInviteQuota(status),
  };
  return jsonResponse(view, 200, req);
}

/** GET /api/linkedin/touched: how many profiles the suppression list holds. */
export async function linkedInTouchedCountRoute(req: Request): Promise<Response> {
  const view: LinkedInTouchedView = { count: getSharedDb().countLinkedInTouched() };
  return jsonResponse(view, 200, req);
}

/**
 * POST /api/linkedin/touched `{ content, source? }`: the same import as
 * `oneshot-gtm linkedin import-touched <file>`. `content` is the CSV or JSON
 * text of the uploaded file. Sends nothing and touches no cadence.
 */
export async function linkedInTouchedImportRoute(req: Request): Promise<Response> {
  let body: { content?: unknown; source?: unknown };
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse({ error: "JSON object body required" }, 400, req);
    }
    body = parsed as typeof body;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (typeof body.content !== "string" || !body.content.trim()) {
    return jsonResponse({ error: "content (the file's text) is required" }, 400, req);
  }
  if (body.source !== undefined && typeof body.source !== "string") {
    return jsonResponse({ error: "source must be a string" }, 400, req);
  }
  let rows;
  try {
    rows = parseTouchedFile(body.content);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400, req);
  }
  const shared = getSharedDb();
  const importOpts: { source?: string } = {};
  if (body.source) importOpts.source = body.source;
  const result = importTouchedProfiles(shared, rows, importOpts);
  const view: LinkedInTouchedImportView = {
    imported: result.imported,
    present: result.present,
    rejected: result.rejected.length,
    rejectedSample: result.rejected.slice(0, 10),
    count: shared.countLinkedInTouched(),
  };
  return jsonResponse(view, 200, req);
}

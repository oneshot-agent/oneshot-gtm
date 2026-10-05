import {
  describeInviteQuota,
  linkedInInviteStatus,
  linkedInOutreachAccount,
} from "@oneshot-gtm/core";
import type { LinkedInInviteQuotaView } from "@oneshot-gtm/shared-types";
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

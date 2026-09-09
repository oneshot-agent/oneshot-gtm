import {
  gmailAccountFor,
  listWritableCalendars,
  loadConfig,
  recentEventCount,
  resolveIdentities,
} from "@oneshot-gtm/core";
import type { CalendarPickerEntry } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * GET /api/setup/calendars?identityId=gmail:jn@x.dev — the /setup calendar
 * picker's source list. Refuses (server-side, via `listWritableCalendars`'
 * `minAccessRole=writer`) anything below writer access — a reader/
 * freeBusyReader calendar returns every event as `summary: "busy"` with no
 * attendees, which reads as a self-block. Each entry carries a 7-day event
 * count because a founder cannot reliably say which calendar their booking
 * tool actually writes to.
 */
export async function listCalendarsRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const identityId = url.searchParams.get("identityId");
  if (!identityId) {
    return jsonResponse({ error: "identityId is required" }, 400, req);
  }
  const cfg = loadConfig();
  const identity = resolveIdentities(cfg).find((i) => i.id === identityId);
  if (!identity || identity.provider !== "gmail") {
    return jsonResponse({ error: `'${identityId}' is not a connected Gmail identity` }, 404, req);
  }
  const account = gmailAccountFor(identity);
  if (!account) {
    return jsonResponse({ error: `no refresh token stored for '${identityId}'` }, 404, req);
  }
  let calendars: Awaited<ReturnType<typeof listWritableCalendars>>;
  try {
    calendars = await listWritableCalendars(account);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 502, req);
  }
  const withCounts: CalendarPickerEntry[] = await Promise.all(
    calendars.map(async (c) => ({
      id: c.id,
      summary: c.summary,
      accessRole: c.accessRole,
      recentEventCount: await recentEventCount(account, c.id),
    })),
  );
  return jsonResponse({ calendars: withCounts }, 200, req);
}

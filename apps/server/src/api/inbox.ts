import { getLedger, listInbox, loadConfig, logEvent } from "@oneshot-gtm/core";
import type { InboxReplyView, InboxResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/** "Jane Doe <jane@x.com>" → "jane@x.com"; bare addresses pass through. */
function normalizeFrom(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? (m[1] ?? raw) : raw).trim().toLowerCase();
}

/**
 * Read-only view of the OneShot inbox (replies to outreach). Each email is
 * matched to a known prospect by sender address, annotated with the play +
 * cadence status when available. Live fetch — no storage. The SDK exposes only
 * inboxList (no reply/markRead), so this is read-only.
 */
export async function listInboxRoute(req: Request): Promise<Response> {
  const ledger = getLedger();

  let emails: Awaited<ReturnType<typeof listInbox>>["emails"];
  try {
    const result = await listInbox({ limit: 50 });
    emails = result.emails;
  } catch (err) {
    logEvent(
      "inbox.list_failed",
      { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
    const out: InboxResult = { replies: [], hasMore: false, error: "couldn't reach the inbox" };
    return jsonResponse(out, 200, req);
  }

  // Cadence-backed prospects (multi-touch plays) carry play + status + name/co
  // in one JOIN. Index by normalized email; prefer a `replied`/`active` cadence
  // when a prospect has several.
  const byEmail = new Map<
    string,
    { name: string | null; company: string | null; playName: string; status: string }
  >();
  for (const c of ledger.listAllCadences()) {
    if (!c.prospect_email) continue;
    const key = c.prospect_email.trim().toLowerCase();
    const existing = byEmail.get(key);
    const better =
      !existing ||
      c.status === "replied" ||
      (c.status === "active" && existing.status !== "replied");
    if (better) {
      byEmail.set(key, {
        name: c.prospect_name,
        company: c.prospect_company,
        playName: c.play_name,
        status: c.status,
      });
    }
  }

  const replies: InboxReplyView[] = emails.map((e) => {
    const fromEmail = normalizeFrom(e.from);
    let matched: InboxReplyView["matched"] = null;
    const cadence = byEmail.get(fromEmail);
    if (cadence) {
      matched = {
        name: cadence.name,
        company: cadence.company,
        playName: cadence.playName,
        cadenceStatus: cadence.status,
      };
    } else {
      // One-touch plays leave no cadence row — fall back to the prospect record.
      const p = ledger.getProspectByEmail(fromEmail);
      if (p) {
        matched = { name: p.name, company: p.company, playName: p.source, cadenceStatus: null };
      }
    }
    return {
      id: e.id,
      fromEmail,
      fromRaw: e.from,
      subject: e.subject,
      receivedAt: e.received_at,
      body: e.body ?? "",
      matched,
    };
  });

  // Drop mail from the founder's own sending domain — the mailbox accumulates
  // the agent's own sends + platform/system test mail (agent@/info@<domain>),
  // which are never genuine prospect replies. Then newest-first.
  const selfDomain = (loadConfig().sendingDomain ?? "").trim().toLowerCase();
  const visible = replies
    .filter((r) => !selfDomain || !r.fromEmail.endsWith(`@${selfDomain}`))
    .toSorted((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));

  const out: InboxResult = { replies: visible, hasMore: false };
  return jsonResponse(out, 200, req);
}

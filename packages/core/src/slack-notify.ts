import { loadConfig } from "./config.ts";
import { logEvent } from "./events.ts";
import { getLedger } from "./ledger.ts";
import type { OneShotConfig } from "./types.ts";

/**
 * Slack incoming-webhook notifications — reply received, bounce recorded,
 * daily send summary. Off unless `cfg.slackWebhookUrl` is set.
 *
 * Hard rules (mirrors telemetry.ts): never throws, never blocks the
 * triggering operation. A failed delivery is logged via logEvent and dropped —
 * no retries, so a dead webhook can't stack up work behind a send or a poll.
 */

export type SlackEventType = "reply_received" | "bounce_recorded" | "daily_send_summary";

export interface SlackReplyReceivedData {
  from_email: string;
  subject: string | null;
  play_name: string | null;
  /** Reply classification (reply-classify.ts), when known. */
  kind: string | null;
}

export interface SlackBounceRecordedData {
  recipient: string;
  kind: string;
  status_code: string | null;
}

export interface SlackDailySendSummaryData {
  /** The completed UTC day being summarized, YYYY-MM-DD. */
  date: string;
  sent: number;
  replied: number;
  bounced: number;
  by_play: Array<{ play_name: string; sent: number; replied: number; bounced: number }>;
}

export type SlackEventData =
  | SlackReplyReceivedData
  | SlackBounceRecordedData
  | SlackDailySendSummaryData;

/** The exact wire shape POSTed to the webhook. */
export interface SlackNotification {
  event_type: SlackEventType;
  timestamp: string;
  data: SlackEventData;
  /**
   * Human-readable summary. Slack incoming webhooks reject payloads that carry
   * no text/blocks/attachments with 400 invalid_payload, so this is what makes
   * the structured payload actually render in a channel.
   */
  text: string;
}

const SLACK_TIMEOUT_MS = 5_000;

/**
 * Escape a string for safe interpolation into a Slack mrkdwn `text` field.
 * Per Slack's formatting spec, `&`, `<`, `>` are the only characters that
 * need escaping — but that's exactly what neutralizes the dangerous cases:
 * `<!channel>`, `<!here>`, `<!everyone>`, `<@U123>` (user mention), and
 * `<#C123>` (channel link) all require literal angle brackets to be parsed
 * as special syntax. Escaping `<`/`>` to `&lt;`/`&gt;` renders any of those
 * sequences appearing in untrusted data (e.g. a prospect's reply subject or
 * from-address) as inert plain text instead of triggering a mention/link.
 */
function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Resolve the configured webhook URL; "" = feature off. Reads via `loadConfig()`
 * (not the process-memoized `loadConfigCached()`) on every call: this is checked
 * once per event, not on a hot per-request path like telemetry, and the
 * long-running server process must see a CLI-driven enable/disable of the
 * webhook without a restart — a stale cached "on" would keep POSTing
 * prospect data after the operator turned it off.
 */
export function slackWebhookUrl(
  cfg: Pick<OneShotConfig, "slackWebhookUrl"> = loadConfig(),
): string {
  return (cfg.slackWebhookUrl ?? "").trim();
}

/**
 * One bounded POST — no retries. Failures (reject, timeout, non-2xx) are
 * logged and swallowed; the returned promise always resolves.
 * Exported for test mocking only.
 */
export async function postToWebhook(
  payload: SlackNotification,
  url: string,
  timeoutMs = SLACK_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      logEvent(
        "slack.notify.failed",
        { event_type: payload.event_type, status: res.status },
        "warn",
      );
    }
  } catch (err) {
    logEvent(
      "slack.notify.failed",
      {
        event_type: payload.event_type,
        message_120: ((err as Error)?.message ?? "").slice(0, 120),
      },
      "warn",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function notify(
  eventType: SlackEventType,
  data: SlackEventData,
  text: string,
): Promise<void> {
  try {
    const url = slackWebhookUrl();
    if (!url) return;
    await postToWebhook(
      { event_type: eventType, timestamp: new Date().toISOString(), data, text },
      url,
    );
  } catch (err) {
    // Belt-and-braces: even a config-read failure must not surface to the caller.
    logEvent(
      "slack.notify.failed",
      { event_type: eventType, message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
  }
}

export async function notifySlackReplyReceived(data: SlackReplyReceivedData): Promise<void> {
  const fromEmail = escapeSlackText(data.from_email);
  const subject = data.subject ? escapeSlackText(data.subject) : null;
  const playName = data.play_name ? escapeSlackText(data.play_name) : null;
  await notify(
    "reply_received",
    data,
    `Reply from ${fromEmail}${subject ? ` — "${subject}"` : ""}${playName ? ` (${playName})` : ""}`,
  );
}

export async function notifySlackBounceRecorded(data: SlackBounceRecordedData): Promise<void> {
  const recipient = escapeSlackText(data.recipient);
  const kind = escapeSlackText(data.kind);
  const statusCode = data.status_code ? escapeSlackText(data.status_code) : null;
  await notify(
    "bounce_recorded",
    data,
    `Bounce (${kind}${statusCode ? ` ${statusCode}` : ""}) for ${recipient}`,
  );
}

export async function notifySlackDailySendSummary(data: SlackDailySendSummaryData): Promise<void> {
  await notify(
    "daily_send_summary",
    data,
    `Send summary for ${data.date}: ${data.sent} sent, ${data.replied} replied, ${data.bounced} bounced`,
  );
}

/** poll_state key holding the last UTC day a summary was posted (or skipped as quiet). */
export const SLACK_DAILY_SUMMARY_WATERMARK = "slack_daily_summary";

/** UTC calendar day of `d`, YYYY-MM-DD. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate and post the daily send summary for the most recently COMPLETED
 * UTC day. Cheap to call on every scheduler tick: it no-ops unless a webhook
 * is configured and that day hasn't been handled yet (poll_state watermark).
 * At-most-once — the watermark is stamped before the POST, so a failed
 * delivery is dropped rather than re-attempted (best-effort by contract).
 * Quiet days (no sequence events at all) stamp without posting.
 * `sent`/`replied` count `sequence_events` rows whose OWN occurrence landed
 * in the window — see Ledger.eventsByPlay's replied_at note. `bounced` is
 * NOT derived from `sequence_events`: `pollInboxBounces` writes one
 * `sequence_events` row per CONCURRENT cadence a bounced prospect is
 * enrolled in (so one DSN can appear several times there) and skips it
 * entirely for soft bounces and for bounces on prospects with no ledger
 * match (both still hit the `bounces` table and both still fire
 * `notifySlackBounceRecorded`); the dead-mailbox-autoresponder bounce path
 * (`auto_permanent`, via pollInboxReplies) has the identical multi-cadence
 * duplication problem but never touches `bounces` at all. So `bounced` is
 * the sum of `ledger.countBounces` (DSN path, one row per event in the
 * `bounces` table) and `ledger.countAutoPermanentBounces` (reply-stream
 * path, de-duplicated per prospect+occurrence) — the two disjoint,
 * individually-deduplicated sources that together cover every bounce this
 * codebase records. Returns true when a summary was posted. Never throws.
 *
 * `opts.sweepClean`: pass `false` when the CALLER's own bounce sweep this
 * tick came back partial (a source errored or was skipped — see
 * pollInboxBounces' `clean` flag) or didn't run at all when one was needed.
 * The watermark for the completed day must not be stamped on a tick where
 * this function cannot be sure every bounce for that day has actually been
 * swept yet — the scheduler forces a bounce sweep on the tick that crosses
 * the UTC day boundary specifically so this function has a trustworthy
 * answer here; a `sweepClean: false` on that same tick means the forced
 * sweep itself came back partial, so stamping now would permanently drop
 * whatever bounces the failed source hasn't reported yet (issue #71 round-4
 * review finding). Defaults to `true` (unchanged behaviour) for callers that
 * don't pass it, e.g. direct/test invocations.
 */
export async function postDailySendSummaryIfDue(
  now: Date = new Date(),
  opts: { sweepClean?: boolean } = {},
): Promise<boolean> {
  try {
    if (!slackWebhookUrl()) return false;
    // 24h back always lands on the previous UTC calendar day (UTC days are a
    // uniform 86 400s), so `utcDay(now)` is exactly that day's end boundary.
    const day = utcDay(new Date(now.getTime() - 86_400_000));
    const ledger = getLedger();
    if (ledger.getPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK) === day) return false;
    if (opts.sweepClean === false) {
      logEvent("slack.daily_summary.deferred", { day, reason: "bounce_sweep_partial" }, "warn");
      return false;
    }
    ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, day);
    // sqlite-format bounds ("YYYY-MM-DD HH:MM:SS") so the string comparison
    // matches sequence_events.created_at, which is datetime('now')-stamped.
    // Upper-bounded (exclusive) at the next day's start (= utcDay(now), since
    // `day` is utcDay(now - 24h)) so a day already summarized doesn't keep
    // absorbing today's in-flight events on retries.
    const nextDay = utcDay(now);
    const rows = ledger.eventsByPlay({
      sinceIso: `${day} 00:00:00`,
      untilIso: `${nextDay} 00:00:00`,
      occurrenceWindow: true,
    });
    const sent = rows.reduce((a, r) => a + r.sent, 0);
    const replied = rows.reduce((a, r) => a + r.replied, 0);
    // Both bounce sources stamp their own `bounced_at` as `.toISOString()`
    // (gmail.ts's DSN internalDate and the inbound autoresponder's
    // received_at respectively) — NOT the sqlite `datetime('now')` format
    // used above — hence the separate ISO-format window bounds here.
    const isoWindow = { sinceIso: `${day}T00:00:00.000Z`, untilIso: `${nextDay}T00:00:00.000Z` };
    const bounced = ledger.countBounces(isoWindow) + ledger.countAutoPermanentBounces(isoWindow);
    if (sent === 0 && replied === 0 && bounced === 0) return false;
    await notifySlackDailySendSummary({
      date: day,
      sent,
      replied,
      bounced,
      // Per-play `bounced` stays sourced from `eventsByPlay` (sequence_events),
      // NOT the corrected top-level total above: the `bounces` table has no
      // play_name, and one DSN can stop several concurrent cadences on
      // different plays via pollInboxBounces' per-cadence loop, so there is
      // no single correct play to attribute it to. This is a best-effort,
      // known-approximate breakdown; the top-level `bounced` figure above is
      // the accurate one and the two are not guaranteed to sum to the same
      // value (issue #71 round-3 review finding — scoped to the total only).
      by_play: rows.map((r) => ({
        play_name: r.play_name,
        sent: r.sent,
        replied: r.replied,
        bounced: r.bounced,
      })),
    });
    return true;
  } catch (err) {
    logEvent(
      "slack.daily_summary.failed",
      { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
    return false;
  }
}

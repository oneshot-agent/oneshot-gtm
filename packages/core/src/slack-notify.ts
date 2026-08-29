import { loadConfigCached } from "./config.ts";
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

/** Resolve the configured webhook URL; "" = feature off. */
export function slackWebhookUrl(
  cfg: Pick<OneShotConfig, "slackWebhookUrl"> = loadConfigCached(),
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
      logEvent("slack.notify.failed", { event_type: payload.event_type, status: res.status }, "warn");
    }
  } catch (err) {
    logEvent(
      "slack.notify.failed",
      { event_type: payload.event_type, message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function notify(eventType: SlackEventType, data: SlackEventData, text: string): Promise<void> {
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
  await notify(
    "reply_received",
    data,
    `Reply from ${data.from_email}${data.subject ? ` — "${data.subject}"` : ""}${data.play_name ? ` (${data.play_name})` : ""}`,
  );
}

export async function notifySlackBounceRecorded(data: SlackBounceRecordedData): Promise<void> {
  await notify(
    "bounce_recorded",
    data,
    `Bounce (${data.kind}${data.status_code ? ` ${data.status_code}` : ""}) for ${data.recipient}`,
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
 * Returns true when a summary was posted. Never throws.
 */
export async function postDailySendSummaryIfDue(now: Date = new Date()): Promise<boolean> {
  try {
    if (!slackWebhookUrl()) return false;
    // 24h back always lands on the previous UTC calendar day (UTC days are a
    // uniform 86 400s), so `utcDay(now)` is exactly that day's end boundary.
    const day = utcDay(new Date(now.getTime() - 86_400_000));
    const ledger = getLedger();
    if (ledger.getPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK) === day) return false;
    ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, day);
    // sqlite-format bounds ("YYYY-MM-DD HH:MM:SS") so the string comparison
    // matches sequence_events.created_at, which is datetime('now')-stamped.
    const rows = ledger.eventsByPlay({
      sinceIso: `${day} 00:00:00`,
    });
    const sent = rows.reduce((a, r) => a + r.sent, 0);
    const replied = rows.reduce((a, r) => a + r.replied, 0);
    const bounced = rows.reduce((a, r) => a + r.bounced, 0);
    if (sent === 0 && replied === 0 && bounced === 0) return false;
    await notifySlackDailySendSummary({
      date: day,
      sent,
      replied,
      bounced,
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

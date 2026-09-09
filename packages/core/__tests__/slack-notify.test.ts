import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notifySlackBounceRecorded,
  notifySlackReplyReceived,
  notifySlackDailySendSummary,
  postDailySendSummaryIfDue,
  postToWebhook,
  slackWebhookUrl,
  SLACK_DAILY_SUMMARY_WATERMARK,
  type SlackNotification,
} from "../src/slack-notify.ts";
import * as config from "../src/config.ts";
import * as events from "../src/events.ts";
import { getLedger } from "../src/ledger.ts";

describe("slack-notify", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logEventSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock global fetch
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    // Spy on logEvent to verify error logging
    logEventSpy = vi.spyOn(events, "logEvent");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("slackWebhookUrl", () => {
    it("returns empty string when config is null", () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: null,
      } as any);
      expect(slackWebhookUrl()).toBe("");
    });

    it("trims the configured URL", () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "  https://hooks.slack.com/test  ",
      } as any);
      expect(slackWebhookUrl()).toBe("https://hooks.slack.com/test");
    });
  });

  describe("notifySlackReplyReceived", () => {
    it("does nothing when webhook URL is not configured", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: null,
      } as any);

      await notifySlackReplyReceived({
        from_email: "test@example.com",
        subject: "Test",
        play_name: "test-play",
        kind: "human",
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("posts correct payload when configured", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      await notifySlackReplyReceived({
        from_email: "jane@acme.com",
        subject: "RE: Your email",
        play_name: "cold-outreach",
        kind: "human",
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const calls = fetchMock.mock.calls;
      expect(calls).toBeDefined();
      const [url, opts] = calls![0]!;
      expect(url).toBe("https://hooks.slack.com/test");
      expect(opts.method).toBe("POST");
      expect(opts.headers).toEqual({ "content-type": "application/json" });

      const payload = JSON.parse(opts.body) as SlackNotification;
      expect(payload.event_type).toBe("reply_received");
      expect(payload.data).toEqual({
        from_email: "jane@acme.com",
        subject: "RE: Your email",
        play_name: "cold-outreach",
        kind: "human",
      });
      expect(payload.text).toContain("jane@acme.com");
      expect(payload.text).toContain("RE: Your email");
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("escapes Slack mrkdwn special characters in text to prevent @channel/@here/mention injection via untrusted subject/from_email", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      await notifySlackReplyReceived({
        from_email: "attacker@evil.com",
        subject: "<!channel> urgent <@U12345> & <#C123|general>",
        play_name: "cold-outreach",
        kind: "human",
      });

      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      // The raw structured data is untouched — only the rendered `text` is escaped.
      expect(payload.data).toMatchObject({
        subject: "<!channel> urgent <@U12345> & <#C123|general>",
      });
      expect(payload.text).not.toContain("<!channel>");
      expect(payload.text).not.toContain("<@U12345>");
      expect(payload.text).not.toContain("<#C123|general>");
      expect(payload.text).toContain("&lt;!channel&gt;");
      expect(payload.text).toContain("&lt;@U12345&gt;");
      expect(payload.text).toContain("&amp;");
    });

    it("does not throw on fetch failure", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockRejectedValue(new Error("Network error"));

      await expect(
        notifySlackReplyReceived({
          from_email: "test@example.com",
          subject: null,
          play_name: null,
          kind: null,
        }),
      ).resolves.toBeUndefined();

      expect(logEventSpy).toHaveBeenCalledWith(
        "slack.notify.failed",
        expect.objectContaining({ event_type: "reply_received" }),
        "warn",
      );
    });

    it("logs non-2xx responses", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: false, status: 400 } as Response);

      await notifySlackReplyReceived({
        from_email: "test@example.com",
        subject: null,
        play_name: null,
        kind: null,
      });

      expect(logEventSpy).toHaveBeenCalledWith(
        "slack.notify.failed",
        { event_type: "reply_received", status: 400 },
        "warn",
      );
    });
  });

  describe("notifySlackBounceRecorded", () => {
    it("posts correct payload", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      await notifySlackBounceRecorded({
        recipient: "invalid@example.com",
        kind: "hard",
        status_code: "5.1.1",
      });

      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      expect(payload.event_type).toBe("bounce_recorded");
      expect(payload.data).toEqual({
        recipient: "invalid@example.com",
        kind: "hard",
        status_code: "5.1.1",
      });
      expect(payload.text).toContain("hard");
      expect(payload.text).toContain("5.1.1");
      expect(payload.text).toContain("invalid@example.com");
    });

    it("escapes Slack mrkdwn special characters in bounce recipient/kind", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      await notifySlackBounceRecorded({
        recipient: "<!here> attacker@evil.com",
        kind: "hard",
        status_code: "5.1.1",
      });

      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      expect(payload.text).not.toContain("<!here>");
      expect(payload.text).toContain("&lt;!here&gt;");
    });

    it("does not throw on timeout", async () => {
      // Real fetch rejects with AbortError when the signal fires; the mock
      // must honor the signal the same way or the await never settles.
      fetchMock.mockImplementation(
        (_url: unknown, init: unknown) =>
          new Promise((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      );

      // Call postToWebhook directly with 100ms timeout
      await postToWebhook(
        {
          event_type: "bounce_recorded",
          timestamp: new Date().toISOString(),
          data: { recipient: "test@example.com", kind: "soft", status_code: null },
          text: "test",
        },
        "https://hooks.slack.com/test",
        100, // 100ms timeout for test
      );

      expect(logEventSpy).toHaveBeenCalledWith(
        "slack.notify.failed",
        expect.objectContaining({ event_type: "bounce_recorded" }),
        "warn",
      );
    }, 1000); // 1s test timeout
  });

  describe("notifySlackDailySendSummary", () => {
    it("posts correct payload", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      await notifySlackDailySendSummary({
        date: "2026-08-28",
        sent: 42,
        replied: 3,
        bounced: 1,
        by_play: [
          { play_name: "play-a", sent: 30, replied: 2, bounced: 0 },
          { play_name: "play-b", sent: 12, replied: 1, bounced: 1 },
        ],
      });

      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      expect(payload.event_type).toBe("daily_send_summary");
      expect(payload.data).toHaveProperty("date", "2026-08-28");
      expect(payload.data).toHaveProperty("sent", 42);
      expect(payload.text).toContain("2026-08-28");
      expect(payload.text).toContain("42 sent");
      expect(payload.text).toContain("3 replied");
    });
  });

  describe("postDailySendSummaryIfDue", () => {
    it("does nothing when webhook URL is not configured", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: null,
      } as any);

      const posted = await postDailySendSummaryIfDue(new Date("2026-08-29T10:00:00Z"));

      expect(posted).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does nothing when day already processed", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);

      const ledger = getLedger();
      ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, "2026-08-28");

      const posted = await postDailySendSummaryIfDue(new Date("2026-08-29T10:00:00Z"));

      expect(posted).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stamps watermark even on quiet days", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);

      const ledger = getLedger();
      // Clear any existing watermark
      ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, "");

      // eventsByPlay will return empty array for a quiet day
      const posted = await postDailySendSummaryIfDue(new Date("2026-08-29T10:00:00Z"));

      expect(posted).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      // Watermark should be set to prevent re-checking
      expect(ledger.getPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK)).toBe("2026-08-28");
    });

    it("does not throw on ledger errors", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);

      // Force an error by passing invalid parameters
      const posted = await postDailySendSummaryIfDue(new Date("invalid"));

      expect(posted).toBe(false);
      expect(logEventSpy).toHaveBeenCalledWith(
        "slack.daily_summary.failed",
        expect.objectContaining({ message_120: expect.any(String) }),
        "warn",
      );
    });

    it("excludes events from the in-progress day (upper-bounded to the completed day)", async () => {
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      const ledger = getLedger();
      ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, "");
      const pid = ledger.upsertProspect({ name: "D", email: "d@x.com", source: "t" });
      const db = (
        ledger as unknown as {
          db: { query(s: string): { run(...a: unknown[]): unknown } };
        }
      ).db;
      // Completed day (2026-08-28): the summary target.
      db.query(
        `INSERT INTO sequence_events (prospect_id, play_name, step_index, channel, status, created_at)
         VALUES (?, 'show-hn', 0, 'email', 'sent', '2026-08-28 12:00:00')`,
      ).run(pid);
      // Same-instant as `now` (2026-08-29, still in progress): must NOT be counted,
      // or a retry mid-day would double-count events that land after this call.
      db.query(
        `INSERT INTO sequence_events (prospect_id, play_name, step_index, channel, status, created_at)
         VALUES (?, 'show-hn', 1, 'email', 'sent', '2026-08-29 09:00:00')`,
      ).run(pid);

      const posted = await postDailySendSummaryIfDue(new Date("2026-08-29T10:00:00Z"));

      expect(posted).toBe(true);
      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      expect(payload.data).toMatchObject({ date: "2026-08-28", sent: 1 });
    });

    it("credits a reply to the day it actually arrived, not the day the original email was sent", async () => {
      // Regression test for the round-1 review finding: markLatestStepReplied
      // flips the ORIGINAL sent row in place, so its created_at stays pinned
      // to the send date. Before eventsByPlay windowed `replied` on
      // replied_at, a reply landing after the send day's 24h window was
      // permanently dropped from every future daily summary.
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      const ledger = getLedger();
      ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, "");
      const pid = ledger.upsertProspect({ name: "LateReply", email: "lr@x.com", source: "t" });
      ledger.recordSequenceEvent({
        prospectId: pid,
        playName: "repo-interest",
        stepIndex: 0,
        channel: "email",
        status: "sent",
      });
      const db = (
        ledger as unknown as {
          db: { query(s: string): { run(...a: unknown[]): unknown } };
        }
      ).db;
      // The email was sent 8 days before the reply — well outside the
      // completed day's 24h window the summary aggregates over.
      db.query(
        `UPDATE sequence_events SET created_at = '2026-08-20 09:00:00' WHERE prospect_id = ?`,
      ).run(pid);
      // recordCadenceReply is the real call path (inbox poll / /api/inbox);
      // it stamps replied_at to "now" via markLatestStepReplied.
      const nowIso = "2026-08-28 15:00:00";
      db.query(
        `UPDATE sequence_events SET status = 'replied', replied_at = ? WHERE prospect_id = ?`,
      ).run(nowIso, pid);

      const posted = await postDailySendSummaryIfDue(new Date("2026-08-29T10:00:00Z"));

      expect(posted).toBe(true);
      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      expect(payload.data).toMatchObject({ date: "2026-08-28", replied: 1 });
    });

    it("counts a bounce once even when the DSN stopped multiple concurrent cadences (round-3 review fix)", async () => {
      // Regression test for the round-3 review finding: eventsByPlay's
      // `bounced` sum double-counted a single DSN when pollInboxBounces wrote
      // one sequence_events row per cadence the prospect was enrolled in.
      // postDailySendSummaryIfDue must count real bounce EVENTS (the
      // `bounces` table), not sequence_events rows.
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      const ledger = getLedger();
      ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, "");
      const pid = ledger.upsertProspect({ name: "Multi", email: "multi@x.com", source: "t" });
      // One real bounce event...
      ledger.recordBounce({
        messageId: "dsn-multi",
        recipient: "multi@x.com",
        identityId: "gmail:me@corp.example",
        kind: "hard",
        statusCode: "5.1.1",
        diagnostic: "smtp; 550 user unknown",
        prospectId: pid,
        bouncedAt: "2026-08-28T09:00:00.000Z",
      });
      // ...but pollInboxBounces' per-cadence loop writes TWO sequence_events
      // rows for it (the prospect was enrolled in two concurrent cadences).
      for (const playName of ["play-a", "play-b"]) {
        ledger.recordSequenceEvent({
          prospectId: pid,
          playName,
          stepIndex: 0,
          channel: "email",
          status: "bounced",
          metadata: { kind: "hard", statusCode: "5.1.1" },
          bouncedAt: "2026-08-28T09:00:00.000Z",
        });
      }

      const posted = await postDailySendSummaryIfDue(new Date("2026-08-29T10:00:00Z"));

      expect(posted).toBe(true);
      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      // Must be 1 (the real event count), not 2 (the sequence_events row count).
      expect(payload.data).toMatchObject({ date: "2026-08-28", bounced: 1 });
    });

    it("counts a bounce recorded on a prospect with no cadence match (round-3 review fix)", async () => {
      // Regression test: pollInboxBounces `continue`s before writing ANY
      // sequence_events row for a bounce on an address it can't match to a
      // prospect — the old eventsByPlay-derived total silently dropped it.
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      const ledger = getLedger();
      ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, "");
      ledger.recordBounce({
        messageId: "dsn-unmatched",
        recipient: "unknown@x.com",
        identityId: "gmail:me@corp.example",
        kind: "hard",
        statusCode: "5.1.1",
        diagnostic: null,
        prospectId: null,
        bouncedAt: "2026-09-01T09:00:00.000Z",
      });

      const posted = await postDailySendSummaryIfDue(new Date("2026-09-02T10:00:00Z"));

      expect(posted).toBe(true);
      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      expect(payload.data).toMatchObject({ date: "2026-09-01", bounced: 1 });
    });

    it("counts a soft bounce even though it never stops a cadence (round-3 review fix)", async () => {
      // Regression test: pollInboxBounces `continue`s before writing a
      // sequence_events row for soft bounces.
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      const ledger = getLedger();
      ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, "");
      ledger.recordBounce({
        messageId: "dsn-soft",
        recipient: "soft@x.com",
        identityId: "gmail:me@corp.example",
        kind: "soft",
        statusCode: "4.2.2",
        diagnostic: null,
        prospectId: null,
        bouncedAt: "2026-09-02T09:00:00.000Z",
      });

      const posted = await postDailySendSummaryIfDue(new Date("2026-09-03T10:00:00Z"));

      expect(posted).toBe(true);
      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      expect(payload.data).toMatchObject({ date: "2026-09-02", bounced: 1 });
    });

    it("counts a dead-mailbox autoresponder bounce that stopped multiple concurrent cadences as one", async () => {
      // The auto_permanent reply-stream path has the identical multi-cadence
      // duplication problem as DSN bounces, but never touches the `bounces`
      // table — countAutoPermanentBounces must de-duplicate it separately.
      vi.spyOn(config, "loadConfig").mockReturnValue({
        slackWebhookUrl: "https://hooks.slack.com/test",
      } as any);
      fetchMock.mockResolvedValue({ ok: true } as Response);

      const ledger = getLedger();
      ledger.setPollWatermark(SLACK_DAILY_SUMMARY_WATERMARK, "");
      const pid = ledger.upsertProspect({ name: "Dead", email: "dead@x.com", source: "t" });
      const bouncedAt = "2026-09-03T09:00:00.000Z";
      for (const playName of ["play-a", "play-b"]) {
        ledger.recordSequenceEvent({
          prospectId: pid,
          playName,
          stepIndex: 0,
          channel: "email",
          status: "bounced",
          metadata: { reason: "auto-reply-permanent" },
          bouncedAt,
        });
      }

      const posted = await postDailySendSummaryIfDue(new Date("2026-09-04T10:00:00Z"));

      expect(posted).toBe(true);
      const payload = JSON.parse(fetchMock.mock.calls![0]![1]!.body) as SlackNotification;
      expect(payload.data).toMatchObject({ date: "2026-09-03", bounced: 1 });
    });
  });

  describe("non-blocking behavior", () => {
    it("catches all errors and never propagates them", async () => {
      vi.spyOn(config, "loadConfig").mockImplementation(() => {
        throw new Error("Config explosion");
      });

      // None of these should throw
      await expect(
        notifySlackReplyReceived({
          from_email: "test@example.com",
          subject: null,
          play_name: null,
          kind: null,
        }),
      ).resolves.toBeUndefined();

      await expect(
        notifySlackBounceRecorded({
          recipient: "test@example.com",
          kind: "hard",
          status_code: null,
        }),
      ).resolves.toBeUndefined();

      await expect(
        notifySlackDailySendSummary({
          date: "2026-08-28",
          sent: 0,
          replied: 0,
          bounced: 0,
          by_play: [],
        }),
      ).resolves.toBeUndefined();

      expect(logEventSpy).toHaveBeenCalledTimes(3);
    });
  });
});

import {
  demoMode,
  logEvent,
  type TelemetryOutcome,
  postDailySendSummaryIfDue,
  refreshPendingDirectMail,
  withDeadline,
} from "@oneshot-gtm/core";
import {
  nextSleepMs,
  runDueTriggers,
  runPendingRetries,
  type TriggerRunOutcome,
} from "@oneshot-gtm/find";
import {
  backfillMailAddresses,
  pollCalendarMeetings,
  pollInboxBounces,
  pollInboxReplies,
} from "@oneshot-gtm/plays";
import { reportServerExecution } from "./telemetry.ts";

/**
 * Map a fired trigger's outcome to a telemetry outcome. A thrown error is an
 * error; so is a finder that returned but `halted` early (e.g. cost cap, all
 * cohorts empty) — that's a degraded run, not a clean success, and lumping it
 * into "ok" would understate the real failure rate. Exported for unit tests.
 */
export function triggerOutcome(o: TriggerRunOutcome): TelemetryOutcome {
  return o.error || o.result?.halted ? "error" : "ok";
}

/**
 * Background scheduler: polls registered triggers on their interval and fires
 * due ones inside the dashboard server process. Safety: per-trigger atomic
 * claim (in `runDueTriggers`) prevents double-spend when a manual run races a
 * tick; tick-level try/catch backs off 60s so one throw can't kill the loop;
 * runs orphaned by process exit are reconciled by the cold-boot sweep. The
 * tick also polls inbox replies and bounces (both non-spending); tick cadence
 * is clamped to REPLY_POLL_MAX so they surface within minutes.
 */
export interface SchedulerHandle {
  stop(): void;
}

const FIRST_TICK_DELAY_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const REPLY_POLL_MAX_MS = 5 * 60_000;
/**
 * Bounces are swept far less often than replies: the sweep re-reads a 30-day
 * DSN window, so reply-cadence polling would re-parse the same data for
 * nothing, while replies are time-sensitive (cadence might send again).
 */
const BOUNCE_POLL_INTERVAL_MS = 30 * 60_000;
/**
 * Calendar poll throttle (issue #577): mirrors the bounce sweep's cadence —
 * nothing about a meeting is minute-sensitive, so there's no reason to poll
 * it on the same ~tick-length cadence as replies.
 */
const CALENDAR_POLL_INTERVAL_MS = 10 * 60_000;

export function startScheduler(): SchedulerHandle {
  // Demo mode idles: firing triggers would hit placeholder credentials and
  // overwrite the seeded last_run_summary / last_polled_at values.
  if (demoMode()) {
    logEvent("demo.scheduler_idle");
    return { stop: () => {} };
  }

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 0 = never polled, so the first tick always sweeps.
  let lastBouncePollAt = 0;
  let mailBackfillRunning = false;
  // True unless the most recent sweep that actually ran came back partial or
  // failed outright. Lives OUTSIDE the tick closure (not re-initialized per
  // tick) — it must persist across ticks, not just describe the current one:
  // a throttled tick right after a partial/failed sweep runs no sweep of its
  // own, so if this flag reset to `true` every tick it would hand
  // postDailySendSummaryIfDue a false "clean" on the very next tick and
  // permanently watermark a day the forced sweep never actually finished
  // confirming (issue #71 round-5 review finding — this is the bug the
  // round-4 fix was supposed to prevent, recurring one tick later because
  // the flag wasn't carried forward). Only a tick whose sweep actually runs
  // updates it, to either outcome; ticks with no sweep due leave it as the
  // last sweep left it.
  let bouncePollClean = true;
  // Same reasoning as bouncePollClean above, for the reply-poll side (issue
  // #71 round-1 correction): postDailySendSummaryIfDue's watermark also
  // depends on every one of yesterday's replies being recorded, and a
  // partial reply poll on the UTC-day-rollover tick must defer the stamp
  // the same way a partial bounce sweep already does. Lives outside the
  // tick closure so a tick that runs no reply poll of its own (there's no
  // throttle here — pollInboxReplies runs every tick — but the pattern is
  // kept identical to bouncePollClean for the same "carry forward, don't
  // reset" reason) doesn't silently re-arm to clean.
  let replyPollClean = true;
  // 0 = never polled, so the first tick can fire the calendar poll too.
  let lastCalendarPollAt = 0;
  // The calendar poll is intentionally NOT included in sweepClean (issue
  // #577) — it must not join bouncePollClean/replyPollClean for
  // postDailySendSummaryIfDue's gate. A calendar outage has nothing to do
  // with whether every SEND-side event for the day is recorded, and folding
  // it in would let a calendar hiccup permanently defer the daily summary
  // watermark. Kept as its own variable, outside the tick closure, purely
  // so its OWN next poll can see whether the last one was clean if that
  // ever becomes relevant — nothing currently reads it.
  let calendarPollClean = true;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      if (!mailBackfillRunning) {
        mailBackfillRunning = true;
        void backfillMailAddresses()
          .catch((e) => logEvent("mail.backfill.failed", { message: String(e) }, "warn"))
          .finally(() => {
            mailBackfillRunning = false;
          });
      }
      const outcomes = await runDueTriggers();
      const fired = outcomes.filter((o) => o.fired).length;
      // Telemetry per fired trigger — detached, must not delay the tick.
      for (const o of outcomes) {
        if (!o.fired) continue;
        void reportServerExecution(`server.trigger.${o.name}`, {
          outcome: triggerOutcome(o),
          durationMs: o.duration_ms ?? 0,
          flags: ["scheduled"],
        });
      }
      // Reply detection is isolated: an inbox outage must not skip trigger
      // scheduling (or vice-versa), and it never sends, so it can't double-spend.
      let repliesDetected = 0;
      let autoRepliesSkipped = 0;
      try {
        const replyPoll = await pollInboxReplies();
        repliesDetected = replyPoll.repliesDetected;
        autoRepliesSkipped = replyPoll.autoRepliesSkipped;
        replyPollClean = replyPoll.clean;
      } catch (err) {
        replyPollClean = false;
        logEvent(
          "scheduler.reply_poll.failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }
      let mailRefreshed = 0,
        mailRefreshFailed = 0;
      try {
        const mail = await refreshPendingDirectMail();
        mailRefreshed = mail.refreshed;
        mailRefreshFailed = mail.failed;
      } catch (err) {
        logEvent(
          "scheduler.direct_mail_refresh.failed",
          { message_120: String(err instanceof Error ? err.message : err).slice(0, 120) },
          "warn",
        );
      }
      // Bounce detection, isolated like the reply poll; non-spending.
      let bouncesRecorded = 0;
      // Throttled to BOUNCE_POLL_INTERVAL_MS, EXCEPT when the UTC calendar day
      // has rolled over since the last sweep: postDailySendSummaryIfDue below
      // stamps an at-most-once watermark for "yesterday" (UTC) on this same
      // tick, and a bounce that arrived before midnight but is still waiting
      // behind the 30-minute throttle would otherwise get its bounced_at
      // windowed into the already-watermarked day and be permanently dropped
      // from every future daily summary (issue #71 round-3 review finding) —
      // not delayed, dropped, since the watermark never re-opens a stamped
      // day. Forcing the sweep here guarantees it runs before the watermark
      // is stamped, on the very tick that crosses the boundary.
      const dayRolledOver =
        lastBouncePollAt > 0 &&
        new Date(lastBouncePollAt).toISOString().slice(0, 10) !==
          new Date().toISOString().slice(0, 10);
      if (Date.now() - lastBouncePollAt >= BOUNCE_POLL_INTERVAL_MS || dayRolledOver) {
        // Stamped before the await, not after: a slow or failing sweep must not
        // let ticks queue up behind it and then all fire at once.
        lastBouncePollAt = Date.now();
        try {
          const bouncePoll = await pollInboxBounces();
          bouncesRecorded = bouncePoll.recorded;
          bouncePollClean = bouncePoll.clean;
        } catch (err) {
          bouncePollClean = false;
          logEvent(
            "scheduler.bounce_poll.failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
      }
      // Drain outage-deferred candidates (time-windowed finders) now the
      // backend may be healthy again. Isolated like the reply poll — its
      // failure must not skip trigger scheduling.
      try {
        await runPendingRetries();
      } catch (err) {
        logEvent(
          "scheduler.pending_retry.failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }
      // Calendar poll (issue #577): a free read, not a spend-gated trigger,
      // so it belongs in the tick body rather than the TRIGGERS registry.
      // Throttled like the bounce sweep — nothing about a meeting is
      // minute-sensitive. Isolated in its own try/catch (wrapping its own
      // internal withDeadline) so a calendar outage can't skip trigger
      // scheduling or the reply poll. Idle (no-op) in demo mode or when no
      // calendarIdentityId is configured — pollCalendarMeetings itself
      // handles both and returns `idle: true` rather than this call site
      // needing to check.
      let meetingsIngested = 0;
      if (Date.now() - lastCalendarPollAt >= CALENDAR_POLL_INTERVAL_MS) {
        lastCalendarPollAt = Date.now();
        try {
          const calendarPoll = await withDeadline(pollCalendarMeetings(), 60_000, "calendar poll");
          meetingsIngested = calendarPoll.meetingsIngested;
          calendarPollClean = calendarPoll.clean;
        } catch (err) {
          calendarPollClean = false;
          logEvent(
            "scheduler.calendar_poll.failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
      }
      // Daily send summary to Slack: fires once per completed UTC day when
      // slackWebhookUrl is set. Isolated like the reply poll — failure must
      // not skip trigger scheduling. Gated on BOTH pollers' cleanliness
      // (issue #71 round-1 correction): the summary's `bounced` total is
      // ledger.countBounces + ledger.countAutoPermanentBounces, sourced from
      // the bounce sweep AND the reply poll respectively, so a partial
      // reply poll on the day-rollover tick is exactly as unsafe to stamp
      // over as a partial bounce sweep — either can permanently drop
      // yesterday's not-yet-recorded events from every future summary.
      try {
        await postDailySendSummaryIfDue(new Date(), {
          sweepClean: bouncePollClean && replyPollClean,
        });
      } catch (err) {
        logEvent(
          "scheduler.daily_summary.failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
      }
      logEvent("scheduler.tick.done", {
        fired,
        repliesDetected,
        autoRepliesSkipped,
        bouncesRecorded,
        mailRefreshed,
        mailRefreshFailed,
        meetingsIngested,
        calendarPollClean,
        source: "server",
      });
      if (cancelled) return;
      const sleepMs = Math.min(nextSleepMs(outcomes), REPLY_POLL_MAX_MS);
      timer = setTimeout(() => void tick(), sleepMs);
    } catch (err) {
      logEvent(
        "scheduler.tick.failed",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "error",
      );
      if (!cancelled) timer = setTimeout(() => void tick(), ERROR_BACKOFF_MS);
    }
  };

  // Short initial delay so the HTTP server is bound and the cold-boot sweep
  // has finished writing `killed_by_restart` summaries before the first tick.
  timer = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);

  return {
    stop(): void {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

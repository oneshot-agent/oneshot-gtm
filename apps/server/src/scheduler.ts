import { refreshReplyLearning } from "./reply-learning.ts";
import { refreshIcpProposal } from "./icp-proposals.ts";
import { resumeLinkedInBackfills } from "./linkedin-backfill.ts";
import { refreshLinkedInInbox } from "./linkedin-sync.ts";
import {
  demoMode,
  getLedger,
  loadConfig,
  runDeliveryChecks,
  runOutboundConfirmations,
  resolveIdentities,
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
  sweepInFlightNewsfeeds,
  sweepLiveProfiles,
  type TriggerRunOutcome,
} from "@oneshot-gtm/find";
import {
  backfillMailAddresses,
  pollCalendarMeetings,
  pollInboxBounces,
  pollInboxReplies,
  retryUntriagedReplies,
} from "@oneshot-gtm/plays";
import { reportServerExecution } from "./telemetry.ts";

/**
 * Count thrown errors and halted finder runs as telemetry errors.
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
 * Calendar polls use the bounce sweep cadence; meetings are less time-sensitive than replies.
 */
const CALENDAR_POLL_INTERVAL_MS = 10 * 60_000;
/**
 * Live LinkedIn profile reads for rows the post-finder hook did not reach
 * (its wall budget fits about four five-minute reads). A few times a day is
 * plenty: the reads are capped per day inside the read path, and a sweep
 * runs its rows one at a time.
 */
const LIVE_PROFILE_SWEEP_INTERVAL_MS = 4 * 60 * 60_000;
const LIVE_PROFILE_SWEEP_DEADLINE_MS = 60 * 60_000;
/** The in-flight newsfeed sweep rides the live-profile interval; 25 calls at ~5-12 s fit easily. */
const NEWSFEED_SWEEP_DEADLINE_MS = 15 * 60_000;
/** Sent-folder delivery checks: every few minutes, a bounded batch of read-only mailbox searches. */
const DELIVERY_SWEEP_INTERVAL_MS = 5 * 60_000;
const DELIVERY_SWEEP_DEADLINE_MS = 2 * 60_000;
/** Untriaged-reply retry: a bounded batch every 15 min, so a reply that keeps failing can't cost a paid call per tick. */
const REPLY_INTENT_RETRY_INTERVAL_MS = 15 * 60_000;

export function startScheduler(): SchedulerHandle {
  // Demo mode idles: firing triggers would hit placeholder credentials and
  // overwrite the seeded last_run_summary / last_polled_at values.
  if (demoMode()) {
    logEvent("demo.scheduler_idle");
    return { stop: () => {} };
  }

  const backfillTimer = setInterval(() => {
    void resumeLinkedInBackfills().catch(() => {});
  }, 15_000);
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 0 = never polled, so the first tick always sweeps.
  let lastBouncePollAt = 0;
  let lastIntentRetryAt = 0;
  let mailBackfillRunning = false;
  // Preserve the last sweep result across throttled ticks. Resetting it to true
  // could watermark a day whose bounce sweep is still incomplete.
  let bouncePollClean = true;
  // Preserve reply-poll cleanliness too: partial replies must defer the daily watermark.
  let replyPollClean = true;
  // 0 = never swept, so the first tick after boot catches up right away.
  let lastLiveProfileSweepAt = 0;
  // 0 = never polled, so the first tick can fire the calendar poll too.
  let lastCalendarPollAt = 0;
  // Calendar failures must not block the daily send summary: they do not affect
  // send-side event completeness. Keep their poll state separate.
  let calendarPollClean = true;
  // 0 = never swept, so the first tick checks recent sends right away.
  let lastDeliverySweepAt = 0;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    void refreshReplyLearning().catch(() =>
      logEvent("scheduler.reply_learning.failed", {}, "warn"),
    );
    void refreshIcpProposal().catch(() => logEvent("scheduler.icp_proposal.failed", {}, "warn"));
    void Promise.resolve()
      .then(() => refreshLinkedInInbox())
      .catch((e) => logEvent("scheduler.linkedin.failed", { message: String(e) }, "warn"));
    try {
      if (!mailBackfillRunning) {
        mailBackfillRunning = true;
        void backfillMailAddresses()
          .catch((e) => logEvent("mail.backfill.failed", { message: String(e) }, "warn"))
          .finally(() => {
            mailBackfillRunning = false;
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
      // Replies the live poll can no longer reach (a failed label released
      // after its poll window, or history older than the classifier). Isolated
      // like the poll; bounded per tick; never sends.
      // Throttled: a reply that keeps failing must not cost a paid call per tick.
      if (Date.now() - lastIntentRetryAt >= REPLY_INTENT_RETRY_INTERVAL_MS) {
        lastIntentRetryAt = Date.now();
        try {
          const retried = await retryUntriagedReplies({ limit: 25 });
          if (retried.checked > 0) logEvent("scheduler.reply_intent_retry", retried);
        } catch (err) {
          logEvent(
            "scheduler.reply_intent_retry.failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
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
      // Force a sweep at UTC rollover before the daily summary stamps yesterday.
      // Otherwise the throttle could leave pre-midnight bounces unrecorded,
      // permanently excluding them from the already-watermarked day.
      const dayRolledOver =
        lastBouncePollAt > 0 &&
        new Date(lastBouncePollAt).toISOString().slice(0, 10) !==
          new Date().toISOString().slice(0, 10);
      const bounceInterval = resolveIdentities(loadConfig()).some((i) => i.provider === "smartlead")
        ? 60_000
        : BOUNCE_POLL_INTERVAL_MS;
      if (Date.now() - lastBouncePollAt >= bounceInterval || dayRolledOver) {
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
      const outcomes = await runDueTriggers();
      const fired = outcomes.filter((o) => o.fired).length;
      // Telemetry per fired trigger: detached, must not delay the tick.
      for (const o of outcomes) {
        if (!o.fired) continue;
        void reportServerExecution(`server.trigger.${o.name}`, {
          outcome: triggerOutcome(o),
          durationMs: o.duration_ms ?? 0,
          flags: ["scheduled"],
        });
      }
      // Drain outage-deferred candidates (time-windowed finders) now the
      // backend may be healthy again. Isolated like the reply poll: its
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
      // Live-profile sweep: rows with a LinkedIn seed and no live read yet,
      // approved first. Spends (~$0.01 a row) under the read path's daily
      // cap; idle without a verified session. Isolated like the others and
      // stamped before the await so a slow sweep never queues ticks up.
      let liveProfilesRead = 0;
      if (Date.now() - lastLiveProfileSweepAt >= LIVE_PROFILE_SWEEP_INTERVAL_MS) {
        lastLiveProfileSweepAt = Date.now();
        try {
          // The sweep stops itself at the deadline (no new row, no write);
          // withDeadline is the backstop for a row already in flight.
          const sweep = await withDeadline(
            sweepLiveProfiles({ deadlineAt: Date.now() + LIVE_PROFILE_SWEEP_DEADLINE_MS }),
            LIVE_PROFILE_SWEEP_DEADLINE_MS + 5 * 60_000,
            "live profile sweep",
          );
          liveProfilesRead = sweep.read;
        } catch (err) {
          logEvent(
            "scheduler.live_profile_sweep.failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
        // Same cadence, its own guard: recent posts for prospects in a running
        // cadence whose cached posts are missing or expired. Needs no LinkedIn
        // session, so it runs even when the read sweep idles.
        try {
          await withDeadline(
            sweepInFlightNewsfeeds({ deadlineAt: Date.now() + NEWSFEED_SWEEP_DEADLINE_MS }),
            NEWSFEED_SWEEP_DEADLINE_MS + 3 * 60_000,
            "in-flight newsfeed sweep",
          );
        } catch (err) {
          logEvent(
            "scheduler.newsfeed_sweep.failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
      }
      // Calendar polling is a free read outside the spend-gated trigger registry.
      // Isolate failures so they cannot skip scheduling or replies; the poller
      // handles deadlines and idles in demo mode or without a calendar identity.
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
      // Delivery checks, read-only and bounded per tick; isolated so a mailbox
      // outage cannot skip the daily summary. Keyed sends (outbound_sends) are
      // confirmed or settled against Sent first; the copy count then audits
      // the unkeyed Smartlead/Gmail receipts that remain.
      if (Date.now() - lastDeliverySweepAt >= DELIVERY_SWEEP_INTERVAL_MS) {
        lastDeliverySweepAt = Date.now();
        try {
          await withDeadline(
            runOutboundConfirmations({
              outbound: getLedger().outboundSends,
              delivery: getLedger().sendDelivery,
              deadlineAt: Date.now() + DELIVERY_SWEEP_DEADLINE_MS,
            }),
            DELIVERY_SWEEP_DEADLINE_MS + 60_000,
            "outbound confirm sweep",
          );
        } catch (err) {
          logEvent(
            "scheduler.outbound_confirm.failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
        try {
          await withDeadline(
            runDeliveryChecks({
              store: getLedger().sendDelivery,
              deadlineAt: Date.now() + DELIVERY_SWEEP_DEADLINE_MS,
            }),
            DELIVERY_SWEEP_DEADLINE_MS + 60_000,
            "delivery check sweep",
          );
        } catch (err) {
          logEvent(
            "scheduler.delivery_sweep.failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
      }
      // Post once per completed UTC day when Slack is configured. Both pollers
      // must be clean: bounce totals include sweep events and auto-permanent
      // bounces from replies. Stamping a partial day would permanently omit events.
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
        liveProfilesRead,
        source: "server",
      });
      if (cancelled) return;
      const replyInterval = resolveIdentities(loadConfig()).some((i) => i.provider === "smartlead")
        ? 60_000
        : REPLY_POLL_MAX_MS;
      const sleepMs = Math.min(nextSleepMs(outcomes), replyInterval);
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
      clearInterval(backfillTimer);
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

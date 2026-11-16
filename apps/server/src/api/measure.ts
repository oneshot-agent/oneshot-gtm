import {
  cadenceRocs,
  getLedger,
  loadConfig,
  logEvent,
  outcomeToValueTag,
  readLinkedInMeasure,
  tagOutcomeValue,
  volumeGoalPerDayOf,
} from "@oneshot-gtm/core";
import type {
  EventsByPlay,
  FunnelDay,
  FunnelFinderDay,
  FunnelView,
  OutcomeByPlay,
  OutcomeRequest,
  RocsGoalView,
  SpendByPlay,
  SpendSeries,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

function readSinceDays(req: Request): string | undefined {
  const url = new URL(req.url);
  const n = Number.parseInt(url.searchParams.get("sinceDays") ?? "", 10);
  if (!Number.isFinite(n)) return undefined;
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

function readPeriodDays(req: Request): number | undefined {
  const n = Number.parseInt(new URL(req.url).searchParams.get("sinceDays") ?? "", 10);
  return Number.isFinite(n) ? n : undefined;
}

export function measureCac(req: Request): Response {
  const sinceIso = readSinceDays(req);
  const ledger = getLedger();
  const spend: SpendByPlay[] = ledger.spendByPlay(sinceIso ? { sinceIso } : {}).map((r) => ({
    playName: r.play_name,
    calls: r.calls,
    totalUsd: r.total_usd,
  }));
  const events: EventsByPlay[] = ledger.eventsByPlay(sinceIso ? { sinceIso } : {}).map((r) => ({
    playName: r.play_name,
    sent: r.sent,
    delivered: r.delivered,
    replied: r.replied,
    bounced: r.bounced,
  }));
  return jsonResponse({ spend, events }, 200, req);
}

export function measureRocs(req: Request): Response {
  const sinceIso = readSinceDays(req);
  const ledger = getLedger();
  const spend: SpendByPlay[] = ledger.spendByPlay(sinceIso ? { sinceIso } : {}).map((r) => ({
    playName: r.play_name,
    calls: r.calls,
    totalUsd: r.total_usd,
  }));
  const events: EventsByPlay[] = ledger.eventsByPlay(sinceIso ? { sinceIso } : {}).map((r) => ({
    playName: r.play_name,
    sent: r.sent,
    delivered: r.delivered,
    replied: r.replied,
    bounced: r.bounced,
  }));
  const outcomes: OutcomeByPlay[] = ledger
    .outcomesByPlay(sinceIso ? { sinceIso } : {})
    .map((r) => ({
      playName: r.play_name,
      meetings: r.meetings,
      sqls: r.sqls,
      won: r.won,
      lost: r.lost,
      ghosted: r.ghosted,
      wonValueUsd: r.won_value_usd,
    }));
  return jsonResponse({ spend, events, outcomes }, 200, req);
}

/**
 * The LinkedIn funnel for this workspace (#792), read-only over the ledger and
 * the synced inbox. Filters: `sinceDays`, `play`, `stepKind`.
 */
export function measureLinkedIn(req: Request): Response {
  const url = new URL(req.url);
  const stepKind = url.searchParams.get("stepKind");
  if (
    stepKind !== null &&
    stepKind !== "first-touch" &&
    stepKind !== "continuation" &&
    stepKind !== "friend"
  ) {
    return jsonResponse(
      { error: "stepKind must be first-touch, continuation or friend" },
      400,
      req,
    );
  }
  const play = url.searchParams.get("play")?.trim();
  const sinceDays = readPeriodDays(req);
  if (sinceDays != null && sinceDays <= 0) {
    return jsonResponse({ error: "sinceDays must be a positive number" }, 400, req);
  }
  const { view } = readLinkedInMeasure({
    ...(sinceDays != null ? { sinceDays } : {}),
    ...(play ? { play } : {}),
    ...(stepKind ? { stepKind } : {}),
  });
  return jsonResponse(view, 200, req);
}

/**
 * Daily spend per play, for the trend sparklines.
 *
 * The window is clamped the way the sparkline draws it: never fewer than seven
 * buckets, never more than ninety, so the response and the chart agree on how
 * many columns exist.
 */
export function measureSpendSeries(req: Request): Response {
  const days = Math.min(90, Math.max(7, readPeriodDays(req) ?? 30));
  const ledger = getLedger();
  const byPlay = new Map<string, number[]>();
  // Bucket index 0 is the oldest day in the window, which is how the sparkline
  // reads it left to right.
  const today = Date.now();
  const DAY_MS = 24 * 3600 * 1000;
  const dayIndex = (day: string): number => {
    const ts = Date.parse(`${day}T00:00:00Z`);
    if (Number.isNaN(ts)) return -1;
    const todayUtc = Math.floor(today / DAY_MS) * DAY_MS;
    return days - 1 - Math.round((todayUtc - ts) / DAY_MS);
  };
  for (const row of ledger.spendSeriesByPlay({ days })) {
    const i = dayIndex(row.day);
    if (i < 0 || i >= days) continue;
    let arr = byPlay.get(row.play_name);
    if (!arr) {
      arr = Array.from({ length: days }, () => 0);
      byPlay.set(row.play_name, arr);
    }
    arr[i] = (arr[i] ?? 0) + row.total_usd;
  }
  const payload: SpendSeries = {
    days,
    series: Array.from(byPlay.entries()).map(([playName, spend]) => ({ playName, spend })),
  };
  return jsonResponse(payload, 200, req);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A local date as YYYY-MM-DD, the form SQLite's `date(x, 'localtime')` gives. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const perUnit = (usd: number, n: number): number | null => (n > 0 ? usd / n : null);

/**
 * The finder a source belongs to: `find:<finder>`. A run reports its
 * finder's source while its rows can carry more (`find:list-page:runs-backstage`
 * per list, `find:github-stars:<repo>` per repo), and a mode can sit on the
 * run's side only (`find:post-funding:auto`). Other sources stay as written.
 */
export function finderSource(source: string): string {
  if (!source.startsWith("find:")) return source;
  return source.split(":").slice(0, 2).join(":");
}

/**
 * Prospects per day, per finder: what its runs found and spent, what reached
 * the queue from it, and what a human approved and sent, with
 * `volumeGoalPerDay` as the goal. Queue rows count on the local day they were
 * found and join runs on the finder their `source` names (`finderSource`); `approvedOnDay` counts approvals on the day
 * they were made. `days` defaults to 14, clamped to 1-90; newest day first.
 */
export function measureFunnel(req: Request): Response {
  const n = Number.parseInt(new URL(req.url).searchParams.get("days") ?? "", 10);
  const days = Math.min(90, Math.max(1, Number.isFinite(n) ? n : 14));
  const now = new Date();
  // Local midnight of the oldest day. Built from calendar fields, not by
  // subtracting 24-hour steps, so a DST change in the window moves nothing.
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const sinceIso = since.toISOString();
  const ledger = getLedger();

  const byDay = new Map<string, Map<string, FunnelFinderDay>>();
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) {
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    dayKeys.push(day);
    byDay.set(day, new Map());
  }
  const entry = (day: string, source: string): FunnelFinderDay | null => {
    const finders = byDay.get(day);
    if (!finders) return null;
    let f = finders.get(source);
    if (!f) {
      f = {
        name: source,
        source,
        runs: 0,
        candidates: 0,
        enqueued: 0,
        queued: 0,
        autoRejected: 0,
        approved: 0,
        rejected: 0,
        sent: 0,
        pending: 0,
        costUsd: 0,
        costPerQueued: null,
        costPerApproved: null,
      };
      finders.set(source, f);
    }
    return f;
  };

  // Two triggers can share a source; the queue cannot tell their rows apart,
  // so they share one entry and its name lists both.
  const names = new Map<FunnelFinderDay, Set<string>>();
  for (const run of ledger.listFinderRunsSince(sinceIso)) {
    const f = entry(run.day, finderSource(run.source));
    if (!f) continue;
    f.runs += 1;
    f.candidates += run.candidates;
    f.enqueued += run.enqueued;
    f.costUsd += run.cost_usd;
    let set = names.get(f);
    if (!set) names.set(f, (set = new Set()));
    set.add(run.name);
  }
  for (const [f, set] of names) f.name = [...set].toSorted().join(", ");

  for (const row of ledger.queueFunnelSince(sinceIso)) {
    const f = entry(row.day, finderSource(row.source));
    if (!f) continue;
    f.queued += row.queued;
    f.autoRejected += row.autoRejected;
    f.approved += row.approved;
    f.rejected += row.rejected;
    f.sent += row.sent;
    f.pending += row.pending;
  }

  const approvedOnDay = new Map(
    ledger.approvedByDecisionDaySince(sinceIso).map((r) => [r.day, r.approved]),
  );
  for (const finders of byDay.values()) {
    for (const f of finders.values()) {
      f.costPerQueued = perUnit(f.costUsd, f.queued);
      f.costPerApproved = perUnit(f.costUsd, f.approved);
    }
  }
  const out: FunnelDay[] = dayKeys.map((day) => ({
    day,
    approvedOnDay: approvedOnDay.get(day) ?? 0,
    finders: [...(byDay.get(day)?.values() ?? [])].toSorted(
      (a, b) => b.queued - a.queued || a.name.localeCompare(b.name),
    ),
  }));
  const payload: FunnelView = { days: out, goalPerDay: volumeGoalPerDayOf(loadConfig()) };
  return jsonResponse(payload, 200, req);
}

export async function recordOutcome(req: Request): Promise<Response> {
  const body = (await req.json()) as OutcomeRequest;
  const allowed = ["meeting_booked", "sql_qualified", "deal_won", "deal_lost", "ghosted"];
  if (!allowed.includes(body.outcome)) {
    return jsonResponse({ error: `outcome must be one of: ${allowed.join(", ")}` }, 400, req);
  }
  const ledger = getLedger();
  const prospect = ledger.findProspectByEmail(body.email);
  if (!prospect) return jsonResponse({ error: `prospect not found: ${body.email}` }, 404, req);
  const id = ledger.recordOutcome({
    prospectId: prospect.id,
    ...(body.playName ? { playName: body.playName } : {}),
    outcome: body.outcome,
    ...(body.amountUsd != null ? { amountUsd: body.amountUsd } : {}),
    ...(body.notes ? { notes: body.notes } : {}),
  });
  // Tag the value of the receipts that earned this outcome. When no play is
  // given, tag every cadence the prospect is in. Best-effort (tagOutcomeValue
  // swallows its own errors). Never block recording the outcome.
  const valueTag = outcomeToValueTag(body.outcome, body.amountUsd ?? undefined);
  if (valueTag) {
    const plays = body.playName
      ? [body.playName]
      : ledger.listCadencesForProspect(prospect.id).map((c) => c.play_name);
    for (const playName of plays) {
      await tagOutcomeValue({ prospectId: prospect.id, playName, valueTag });
    }
  }
  return jsonResponse({ id }, 200, req);
}

/**
 * Per-cadence RoCS: OneShot's goal-level spend-vs-value rollup, labelled with the
 * local play + prospect. Degrades to an empty list (never 500s the Measure page)
 * when the platform read fails or the wallet is unconfigured.
 */
export async function measureRocsByGoal(req: Request): Promise<Response> {
  const periodDays = readPeriodDays(req);
  let goals: RocsGoalView[] = [];
  try {
    const rollups = await cadenceRocs(periodDays != null ? { periodDays } : {});
    const labels = getLedger().goalLabels(rollups.map((g) => g.goalId));
    // Scope to THIS app's cadences: rocsByGoal returns every goal on the wallet
    // (other tools' compute goals, other installs sharing the key); keep only
    // goals we have local receipts for, so the table reads as our cadences.
    goals = rollups
      .filter((g) => labels.has(g.goalId))
      .map((g) => ({
        goalId: g.goalId,
        playName: labels.get(g.goalId)?.playName ?? null,
        prospect: labels.get(g.goalId)?.prospect ?? null,
        spend: g.spend,
        value: g.value,
        pendingValue: g.pendingValue,
        rocs: g.rocs,
        receiptCount: g.receiptCount,
      }));
  } catch (err) {
    logEvent(
      "measure.rocs_by_goal.failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
  }
  return jsonResponse({ goals }, 200, req);
}

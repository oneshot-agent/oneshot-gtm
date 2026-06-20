import {
  cadenceRocs,
  getLedger,
  logEvent,
  outcomeToValueTag,
  tagOutcomeValue,
} from "@oneshot-gtm/core";
import type {
  EventsByPlay,
  OutcomeByPlay,
  OutcomeRequest,
  RocsGoalView,
  SpendByPlay,
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
    }));
  return jsonResponse({ spend, events, outcomes }, 200, req);
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
  // swallows its own errors) — never block recording the outcome.
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
